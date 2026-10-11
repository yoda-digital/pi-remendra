import { randomUUID } from "node:crypto";
import type { MemoryClient } from "./client.js";
import type { ClaimInput, Job, MemoryConfig, Scope, SearchHit } from "./types.js";

/** Input tokens kept free in each batch for the list of known memories. */
const KNOWN_TOKENS = 700;
import {
  abortable,
  dropRestatements,
  type KnownMemory,
  OBSERVER_PROMPT,
  observerInput,
  observerRequestTokens,
  parseObservations,
} from "./observer.js";
import { estimateTokens, redact } from "./text.js";
import { log } from "./log.js";

export interface Completion {
  text: string;
  tokens: number;
  dollars?: number;
}
export type Complete = (request: {
  system: string;
  input: string;
  maxTokens: number;
  signal: AbortSignal;
  attempt: number;
  sessionId: string;
}) => Promise<Completion>;

/**
 * Chunks of user-written text, long enough to hold a fact, that no claim in this answer
 * cites and that have not had their second look yet.
 */
export function secondLookChunks(job: Job, claims: ClaimInput[], minChars = 40): number[] {
  const cited = new Set(claims.flatMap((c) => c.evidence.map((e) => e.sourceKey)));
  return job.chunks
    .filter(
      (c) =>
        !c.secondLook &&
        c.source.role === "user" &&
        !cited.has(c.source.key) &&
        c.source.text.slice(c.start, c.end).trim().length >= minChars,
    )
    .map((c) => c.id);
}

export class BackgroundLearner {
  private controller?: AbortController;
  private running?: Promise<string>;
  private consecutiveFailures = 0;
  constructor(readonly client: MemoryClient) {}
  /** Existing memories related to the batch, so the observer can mark restatements of them. */
  private async knownFor(scope: Scope, job: Job, inputLimit: number): Promise<KnownMemory[]> {
    const text = job.chunks
      .map((c) => c.source.text.slice(c.start, c.end))
      .join("\n")
      .slice(0, 4000);
    try {
      const hits: SearchHit[] = await this.client.call("search", [{ scope, text, limit: 10 }]);
      const known: KnownMemory[] = hits.map((h, n) => ({ n, text: h.claim.text.slice(0, 300) }));
      // Never let the list push the request over its budget.
      while (known.length && observerRequestTokens(job, known) > inputLimit) known.pop();
      return known;
    } catch {
      return [];
    }
  }
  cancel(reason = "Foreground work has priority"): void {
    this.controller?.abort(new Error(reason));
  }
  idle(): boolean {
    return !this.running;
  }
  /** Record a failed batch; escalate to a warning after 3 consecutive failures. */
  private failed(result: string): string {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= 3)
      log(
        `[remendra] learning degraded: ${this.consecutiveFailures} consecutive failed batches: ${result}`,
      );
    return `${result} (${this.consecutiveFailures} consecutive failures)`;
  }
  async stop(): Promise<void> {
    this.cancel();
    await this.running;
  }
  run(
    scope: Scope,
    config: MemoryConfig,
    complete: Complete,
    stillCurrent: () => boolean,
  ): Promise<string> {
    if (this.running) return this.running;
    if (!config.enabled || !config.observer || config.mode === "recall" || !config.dailyTokenBudget)
      return Promise.resolve("Learning paused");
    const controller = new AbortController();
    this.controller = controller;
    this.running = this.observe(
      structuredClone(scope),
      config,
      complete,
      stillCurrent,
      controller.signal,
    ).finally(() => {
      this.running = undefined;
      this.controller = undefined;
    });
    return this.running;
  }
  private async observe(
    scope: Scope,
    config: MemoryConfig,
    complete: Complete,
    stillCurrent: () => boolean,
    signal: AbortSignal,
  ): Promise<string> {
    let learned = 0;
    // Four bounded batches per settled run. Remaining chunks stay visible as gaps.
    for (let batch = 0; batch < 4 && !signal.aborted && stillCurrent(); batch++) {
      let success = false;
      for (
        let attempt = 0;
        attempt < config.maxAttempts && !signal.aborted && stillCurrent();
        attempt++
      ) {
        const inputBudget = Math.max(
          128,
          config.observerInputTokens - estimateTokens(OBSERVER_PROMPT) - 512 - KNOWN_TOKENS,
        );
        const reservation = config.observerInputTokens + config.observerOutputTokens;
        const job: Job | undefined = await this.client.call("lease", [
          scope,
          randomUUID(),
          inputBudget,
          reservation,
          config.dailyTokenBudget,
          config.jobTimeoutMs + 5000,
        ]);
        if (!job)
          return learned
            ? `Learned ${learned} memories; queue or budget exhausted`
            : "No eligible work or daily budget exhausted";
        // What a failed attempt costs the daily budget: nothing if the provider was never
        // called; the request's input if we cancelled it ourselves; the full reservation
        // (undefined) when the call timed out or failed without reporting usage.
        let usage: number | undefined = 0;
        try {
          const known = await this.knownFor(scope, job, config.observerInputTokens);
          if (observerRequestTokens(job, known) > config.observerInputTokens)
            throw new Error("Serialized observer input exceeds its configured budget");
          const combined = AbortSignal.any([signal, AbortSignal.timeout(config.jobTimeoutMs)]);
          // Cancellation can land while the lease RPC is in flight: never start a call that is
          // already cancelled (its rejection would have nowhere to go).
          if (combined.aborted) throw combined.reason ?? new Error("Aborted");
          usage = undefined;
          const result = await abortable(
            complete({
              system: OBSERVER_PROMPT,
              input: observerInput(job, known),
              maxTokens: config.observerOutputTokens,
              signal: combined,
              attempt,
              sessionId: randomUUID(),
            }),
            combined,
          );
          const tokens = result.tokens ?? 0;
          usage = tokens;
          if (signal.aborted || !stillCurrent())
            throw new Error("Discarded background result after session or branch change");
          const observed = parseObservations(result.text, job);
          // Restatements of known memories (often the assistant repeating the packet) are
          // dropped; they still count as covering their text for the second-look decision.
          const { kept: claims, dropped } = dropRestatements(observed, known);
          if (dropped) log(`[remendra] observer skipped ${dropped} restated memories`);
          // A local model sometimes answers [] (or skips one message) for text it extracts
          // fine on another try. User text that no claim cites gets one more look by riding
          // along with the next batch, instead of costing a request of its own.
          await this.client.call("complete", [
            job,
            scope,
            claims,
            tokens,
            result.dollars,
            secondLookChunks(job, observed),
          ]);
          // L13: Re-check after async RPC — generation may have changed during the await
          if (signal.aborted || !stillCurrent())
            log("[remendra] claims committed but generation changed; may be stale");
          learned += claims.length;
          success = true;
          this.consecutiveFailures = 0;
          break;
        } catch (error) {
          const reason = redact(error instanceof Error ? error.message : String(error));
          if (usage === undefined && signal.aborted) usage = observerRequestTokens(job);
          // A retry that succeeds overwrites the chunk's failure reason: keep it in the log.
          if (!signal.aborted)
            log(
              `[remendra] observer attempt ${attempt + 1}/${config.maxAttempts} failed: ${reason}`,
            );
          try {
            await this.client.call("fail", [
              job,
              reason,
              usage,
              attempt + 1 < config.maxAttempts && !signal.aborted ? 0 : 30000,
            ]);
          } catch (failError) {
            // Log the failJob error. If the failJob RPC itself fails, the budget
            // reservation leaks, but recoverJobs() called from lease() sweeps expired
            // leases (releasing the reservation and re-queueing the chunks), so the
            // leak is temporary and the job never wedges. No further recovery needed here.
            const msg = failError instanceof Error ? failError.message : String(failError);
            log("[remendra] failJob failed:", msg, "job:", job.id);
          }
          // Cancelled for foreground work: not a failure, so it never counts toward "degraded".
          if (signal.aborted || !stillCurrent())
            return `Learning paused; ${learned} memories committed`;
          if (attempt + 1 >= config.maxAttempts) return this.failed(`Learning deferred: ${reason}`);
        }
      }
      // Attempts that run out return above; ending here means the work was cancelled.
      if (!success) break;
    }
    return `Learned ${learned} memories`;
  }
}
