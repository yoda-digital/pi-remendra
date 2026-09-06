// Reproducible synthetic benchmark. No network or provider calls.
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";

const directory = mkdtempSync(join(tmpdir(), "remendra-benchmark-"));
const worker = new Worker(new URL("../dist/v2/worker.js", import.meta.url), {
  workerData: { file: join(directory, "memory.sqlite"), directory },
  execArgv: [],
});
let id = 0;
const pending = new Map();
worker.on("message", (response) => {
  const item = pending.get(response.id);
  if (!item) return;
  pending.delete(response.id);
  if (response.error) item.reject(new Error(response.error));
  else item.resolve(response.result);
});
worker.on("error", (error) => {
  for (const item of pending.values()) item.reject(error);
});
const call = (method, args) =>
  new Promise((resolve, reject) => {
    const key = ++id;
    pending.set(key, { resolve, reject });
    worker.postMessage({ id: key, method, args });
  });
const digest = (text) => createHash("sha256").update(text).digest("hex");
const samples = [];
const delay = monitorEventLoopDelay({ resolution: 10 });
delay.enable();
try {
  const count = Number(process.argv[2] ?? 10000);
  if (!Number.isSafeInteger(count) || count < 100 || count > 100000)
    throw new Error("Choose 100–100000 claims");
  const scope = {
    projectId: await call("project", ["/benchmark"]),
    sessionId: "bench",
    entryIds: ["source"],
  };
  const text = "Synthetic benchmark fixture. These records are not real user data.",
    timestamp = "2026-09-06T00:00:00Z";
  const ingested = await call("ingest", [
    scope,
    [{ entryId: "source", text, timestamp, role: "user" }],
  ]);
  const evidence = [
    {
      sourceKey: ingested.keys[0],
      hash: digest(JSON.stringify(["user", text, timestamp, undefined, undefined, undefined])),
      start: 0,
      end: text.length,
    },
  ];
  const start = performance.now();
  for (let i = 0; i < count; i++)
    await call("record", [
      scope,
      {
        id: `benchmark-${String(i).padStart(8, "0")}`,
        text: `Project record ${i}: needle${i} preserves configuration version ${i}.`,
        kind: i % 100 === 0 ? "constraint" : "fact",
        evidence,
      },
      "user",
    ]);
  const seedMs = performance.now() - start;
  for (let i = 0; i < 60; i++) {
    const start = performance.now();
    const packet = await call("compile", [scope, `needle${count - 1}`, 2400]);
    if (!packet.text.includes(`needle${count - 1}`))
      throw new Error("Relevant fact omitted by benchmark query");
    if (i >= 10) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  delay.disable();
  await call("close", []);
  console.log(
    JSON.stringify(
      {
        node: process.version,
        claims: count,
        sources: 1,
        measure: "Worker RPC + scoped FTS retrieval + full packet compilation",
        warmSamples: samples.length,
        seedMs: Math.round(seedMs),
        p50Ms: Number(samples[Math.floor(samples.length * 0.5)].toFixed(2)),
        p95Ms: Number(samples[Math.floor(samples.length * 0.95)].toFixed(2)),
        mainEventLoopP95Ms: Number((delay.percentile(95) / 1e6).toFixed(2)),
        databaseBytes: statSync(join(directory, "memory.sqlite")).size,
        limitations:
          "Synthetic claims sharing one source; warm cache, single process, no provider latency. Not a production SLA.",
      },
      null,
      2,
    ),
  );
} finally {
  await worker.terminate();
  rmSync(directory, { recursive: true, force: true });
}
