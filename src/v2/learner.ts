import { randomUUID } from "node:crypto";
import type { MemoryClient } from "./client.js";
import type { Job, MemoryConfig, Scope } from "./types.js";
import {
  abortable,
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

/** Whether a batch contains user-written text long enough to plausibly hold a fact. */
export function hasUserText(job: Job, minChars = 40): boolean {
  return job.chunks.some(
    (c) =>
      c.source.role === "user" && c.source.text.slice(c.start, c.end).trim().length >= minChars,
  );
}

export class BackgroundLearner {
  private controller?: AbortController;
  private running?: Promise<string>;
  private consecutiveFailures = 0;
  constructor(readonly client: MemoryClient) {}
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
          config.observerInputTokens - estimateTokens(OBSERVER_PROMPT) - 512,
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
          if (observerRequestTokens(job) > config.observerInputTokens)
            throw new Error("Serialized observer input exceeds its configured budget");
          const combined = AbortSignal.any([signal, AbortSignal.timeout(config.jobTimeoutMs)]);
          // Cancellation can land while the lease RPC is in flight: never start a call that is
          // already cancelled (its rejection would have nowhere to go).
          if (combined.aborted) throw combined.reason ?? new Error("Aborted");
          usage = undefined;
          const result = await abortable(
            complete({
              system: OBSERVER_PROMPT,
              input: observerInput(job),
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
          const claims = parseObservations(result.text, job);
          // An empty answer marks the chunks processed for good. When the batch holds real
          // user text and another attempt is left, ask once more before accepting it: a
          // flaky local model sometimes answers [] for input it extracts fine on the next try.
          if (!claims.length && attempt + 1 < config.maxAttempts && hasUserText(job))
            throw new Error("Observer found nothing in user text; asking again to confirm");
          await this.client.call("complete", [job, scope, claims, tokens, result.dollars]);
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
