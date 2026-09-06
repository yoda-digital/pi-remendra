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

export class BackgroundLearner {
  private controller?: AbortController;
  private running?: Promise<string>;
  constructor(readonly client: MemoryClient) {}
  cancel(reason = "Foreground work has priority"): void {
    this.controller?.abort(new Error(reason));
  }
  idle(): boolean {
    return !this.running;
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
          config.jobTimeoutMs + 2000,
        ]);
        if (!job)
          return learned
            ? `Learned ${learned} memories; queue or budget exhausted`
            : "No eligible work or daily budget exhausted";
        let usage: number | undefined = 0;
        try {
          if (observerRequestTokens(job) > config.observerInputTokens)
            throw new Error("Serialized observer input exceeds its configured budget");
          const combined = AbortSignal.any([signal, AbortSignal.timeout(config.jobTimeoutMs)]);
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
          usage = result.tokens;
          if (signal.aborted || !stillCurrent())
            throw new Error("Discarded background result after session or branch change");
          const claims = parseObservations(result.text, job);
          await this.client.call("complete", [job, scope, claims, result.tokens, result.dollars]);
          learned += claims.length;
          success = true;
          break;
        } catch (error) {
          const reason = redact(error instanceof Error ? error.message : String(error));
          try {
            await this.client.call("fail", [
              job,
              reason,
              usage,
              attempt + 1 < config.maxAttempts && !signal.aborted ? 0 : 30000,
            ]);
          } catch {
            /* A lost lease is recovered conservatively on the next reservation. */
          }
          if (signal.aborted || !stillCurrent())
            return `Learning paused; ${learned} memories committed`;
          if (attempt + 1 >= config.maxAttempts) return `Learning deferred: ${reason}`;
        }
      }
      if (!success) break;
    }
    return `Learned ${learned} memories`;
  }
}
