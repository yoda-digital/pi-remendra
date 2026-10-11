import { Worker } from "node:worker_threads";
import type { Args, Method, Result } from "./service.js";
import { log } from "./log.js";
import { CONCURRENT_METHODS } from "./rpc.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Runs outside the worker queue (see CONCURRENT_METHODS). */
  concurrent: boolean;
}

/** Worker death rejects every waiter. A later call opens a fresh worker and recovers SQLite. */
export class MemoryClient {
  private worker?: Worker;
  private sequence = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  constructor(
    readonly file: string,
    readonly directory: string,
    readonly workerURL: URL = new URL("./v2/worker.js", import.meta.url),
  ) {}
  private start(): Worker {
    if (this.closed) throw new Error("Memory client is closed");
    if (this.worker) return this.worker;
    const worker = new Worker(this.workerURL, {
      workerData: { file: this.file, directory: this.directory },
      execArgv: [],
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
    this.worker = worker;
    worker.on("message", (message: { id?: number; error?: string; result?: unknown }) => {
      if (message.id === undefined) return;
      const item = this.pending.get(message.id);
      if (!item) {
        // L4: Late response after timeout — worker completed but caller already rejected
        log(
          "[remendra] late worker response id",
          message.id,
          message.error ? `error: ${message.error}` : "success (data may have been written)",
        );
        return;
      }
      clearTimeout(item.timer);
      this.pending.delete(message.id);
      if (message.error) item.reject(new Error(message.error));
      else item.resolve(message.result);
      if (!this.pending.size) worker.unref();
    });
    worker.on("error", (error) =>
      this.fail(worker, error instanceof Error ? error : new Error(String(error))),
    );
    worker.on("exit", (code) => this.fail(worker, new Error(`Memory worker exited (${code})`)));
    return worker;
  }
  private fail(worker: Worker, error: Error): void {
    if (this.worker !== worker) return;
    this.worker = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    void worker.terminate();
  }
  call<M extends Method>(method: M, args: Args<M>, timeoutMs = 15000): Promise<Result<M>> {
    return new Promise((resolve, reject) => {
      const worker = this.start();
      worker.ref();
      const id = ++this.sequence;
      // The worker runs requests one at a time (except network-bound CONCURRENT_METHODS). A caller that times out while queued behind
      // a slower request only rejects itself. But if the request that timed out is the
      // oldest one still pending, it is the one the worker is executing: the worker is stuck
      // (a pathological regex, a huge synchronous scan), and every later call would time out
      // behind it until Pi restarts. Terminate it instead; the next call starts a fresh
      // worker and SQLite's WAL recovers on reopen.
      const timer = setTimeout(() => {
        const item = this.pending.get(id);
        if (!item) return;
        // Concurrent calls (network-bound) are not in the queue, so they never count as the
        // one executing, and their own timeout never restarts the worker.
        const queued = [...this.pending].filter(([, p]) => !p.concurrent).map(([key]) => key);
        const executing = !item.concurrent && queued.length > 0 && Math.min(...queued) === id;
        if (executing && this.worker === worker) {
          this.fail(
            worker,
            new Error(`Memory ${method} exceeded ${timeoutMs} ms; worker restarted`),
          );
          return;
        }
        clearTimeout(item.timer);
        this.pending.delete(id);
        item.reject(new Error(`Memory ${method} exceeded ${timeoutMs} ms`));
        if (!this.pending.size) worker.unref();
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        concurrent: CONCURRENT_METHODS.includes(method),
      });
      try {
        worker.postMessage({ id, method, args });
      } catch (error) {
        this.fail(worker, error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async close(): Promise<void> {
    if (this.closed) return;
    const worker = this.worker;
    if (worker) {
      try {
        await this.call("close", [], 1000);
      } catch (closeError) {
        // Worker already dead or close timed out; SQLite WAL recovers on reopen
        log(
          "[remendra] close RPC failed:",
          closeError instanceof Error ? closeError.message : String(closeError),
        );
      } finally {
        await worker.terminate();
      }
    }
    this.closed = true;
  }
}
