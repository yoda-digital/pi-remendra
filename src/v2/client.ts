import { Worker } from "node:worker_threads";
import type { Args, Method, Result } from "./service.js";

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
      if (!item) return;
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
  call<M extends Method>(method: M, args: Args<M>, timeoutMs = 5000): Promise<Result<M>> {
    return new Promise((resolve, reject) => {
      const worker = this.start();
      worker.ref();
      const id = ++this.sequence;
      const timer = setTimeout(
        () =>
          this.fail(
            worker,
            new Error(
              `Memory ${method} exceeded ${timeoutMs} ms; worker restarted on next request`,
            ),
          ),
        timeoutMs,
      );
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
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
      } catch {
        /* Already failed; SQLite recovers on reopen. */
      } finally {
        await worker.terminate();
      }
    }
    this.closed = true;
  }
}
