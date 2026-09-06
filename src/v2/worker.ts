import { parentPort, workerData } from "node:worker_threads";
import { MemoryService, RPC_METHODS } from "./service.js";
import { redact } from "./text.js";

if (!parentPort) throw new Error("Memory worker must run in a worker thread");
const port = parentPort;
const service = new MemoryService(String(workerData.file), String(workerData.directory));
async function dispatch(request: { id: number; method: string; args: unknown[] }): Promise<void> {
  try {
    if (
      !(RPC_METHODS as readonly string[]).includes(request.method) ||
      !Array.isArray(request.args)
    )
      throw new Error("Unknown memory operation");
    const method = service[request.method as keyof MemoryService] as (
      ...args: unknown[]
    ) => unknown;
    const result = await method.apply(service, request.args);
    port.postMessage({ id: request.id, result });
    if (request.method === "close") port.close();
  } catch (error) {
    port.postMessage({
      id: request.id,
      error: redact(error instanceof Error ? error.message : String(error)),
    });
  }
}
port.on("message", (request: { id: number; method: string; args: unknown[] }) => {
  void dispatch(request);
});
port.postMessage({ ready: true });
