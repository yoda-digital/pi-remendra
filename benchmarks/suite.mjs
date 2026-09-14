// V2 engine measurement suite: five dimensions, one JSON report.
import { Worker } from "node:worker_threads";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const directory = mkdtempSync(join(tmpdir(), "remendra-suite-"));
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
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
try {
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  const projectId = await call("project", ["/suite"]);
  const s1 = { projectId, sessionId: "s1", entryIds: ["e1"] };
  const s2 = { projectId, sessionId: "s2", entryIds: ["e2"] };
  const text = "Benchmark fixture source record for the v2 suite.";
  const timestamp = "2026-09-06T00:00:00Z";
  const ingested = await call("ingest", [
    s1,
    [{ entryId: "e1", text, timestamp, role: "user" }],
  ]);
  const evidence = [
    {
      sourceKey: ingested.keys[0],
      hash: digest(JSON.stringify(["user", text, timestamp, undefined, undefined, undefined])),
      start: 0,
      end: text.length,
    },
  ];
  const record = (input) => call("record", [s1, { kind: "fact", evidence, ...input }, "user"]);

  // Seed: 500 density + 5 needle + 1000 speed + 50 project-scoped claims.
  for (let i = 0; i < 500; i++)
    await record({ id: `tcd${String(i).padStart(8, "0")}`, text: `test fact ${i}` });
  for (let i = 0; i < 5; i++)
    await record({ id: `tnd${String(i).padStart(8, "0")}`, text: `test XYZZY_NEEDLE_${i}` });
  for (let i = 0; i < 1000; i++)
    await record({ id: `tsp${String(i).padStart(8, "0")}`, text: `speed record ${i}` });
  const survivedIds = [];
  for (let i = 0; i < 50; i++) {
    const id = `tsv${String(i).padStart(8, "0")}`;
    survivedIds.push(id);
    await record({ id, text: `survive claim ${i}`, visibility: "project" });
  }

  // 1. context_density
  const density = await call("compile", [s1, "test", 2400]);
  const contextDensity = clamp(
    (density.manifest.claims.length / 20) * 100,
  );

  // 2. retrieval_precision
  let found = 0;
  for (let i = 0; i < 5; i++) {
    const packet = await call("compile", [s1, `XYZZY_NEEDLE_${i}`, 2400]);
    if (packet.text.includes(`XYZZY_NEEDLE_${i}`)) found++;
  }
  const retrievalPrecision = clamp((found / 5) * 100);

  // 3. compilation_speed: 10 warm + 50 timed compiles, score from p50.
  const samples = [];
  for (let i = 0; i < 60; i++) {
    const start = performance.now();
    await call("compile", [s1, "test", 2400]);
    if (i >= 10) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];
  const compilationSpeed = clamp(((250 - p50) / 200) * 100);

  // 4. memory_survival: recompile in a different session.
  const survival = await call("compile", [s2, "survive", 2400]);
  const survived = new Set(survival.manifest.claims.map((c) => c.id));
  const memorySurvival = clamp(
    (survivedIds.filter((x) => survived.has(x)).length / 50) * 100,
  );

  // 5. budget_utilization
  const budgetUtilization = clamp((density.manifest.tokens / 2400) * 100);

  const dimensions = {
    context_density: contextDensity,
    retrieval_precision: retrievalPrecision,
    compilation_speed: compilationSpeed,
    memory_survival: memorySurvival,
    budget_utilization: budgetUtilization,
  };
  const compositeScore = clamp(
    Object.values(dimensions).reduce((a, b) => a + b, 0) / 5,
  );
  await call("close", []);
  console.log(
    JSON.stringify(
      {
        suite: "remendra-v2",
        dimensions,
        composite_score: compositeScore,
        verdict: compositeScore >= 70 ? "PASS" : "FAIL",
        notes: {
          claims: 1555,
          budget: 2400,
          p50Ms: Number(p50.toFixed(2)),
          foundNeedles: found,
          survivedClaims: survivedIds.filter((x) => survived.has(x)).length,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await worker.terminate();
  rmSync(directory, { recursive: true, force: true });
}
