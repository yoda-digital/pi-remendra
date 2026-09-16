// Remendra v2 smoke tests. Verifies the engine functions, not competitive claims.
// No network, no provider calls. Run: node benchmarks/suite.mjs
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
try {
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  const projectId = await call("project", ["/suite"]);
  const s1 = { projectId, sessionId: "s1", entryIds: ["e1"] };
  const text = "Smoke test source record.";
  const timestamp = "2026-09-06T00:00:00Z";
  const ingested = await call("ingest", [s1, [{ entryId: "e1", text, timestamp, role: "user" }]]);
  const evidence = [
    {
      sourceKey: ingested.keys[0],
      hash: digest(JSON.stringify(["user", text, timestamp, undefined, undefined, undefined])),
      start: 0,
      end: text.length,
    },
  ];
  const record = (input) => call("record", [s1, { kind: "fact", evidence, ...input }, "user"]);

  // Seed claims
  for (let i = 0; i < 500; i++)
    await record({ id: `bench-c-${String(i).padStart(6, "0")}`, text: `project fact ${i}` });
  for (let i = 0; i < 5; i++)
    await record({
      id: `bench-n-${String(i).padStart(6, "0")}`,
      text: `NEEDLE_${i} unique marker`,
    });
  for (let i = 0; i < 500; i++)
    await record({ id: `bench-s-${String(i).padStart(6, "0")}`, text: `speed record ${i}` });
  const survivalIds = [];
  for (let i = 0; i < 50; i++) {
    const cid = `bench-p-${String(i).padStart(6, "0")}`;
    survivalIds.push(cid);
    await record({ id: cid, text: `persist claim ${i}`, visibility: "project" });
  }

  // 1. Can the engine find specific records?
  let needlesFound = 0;
  for (let i = 0; i < 5; i++) {
    const packet = await call("compile", [s1, `NEEDLE_${i}`, 2400]);
    if (packet.text.includes(`NEEDLE_${i}`)) needlesFound++;
  }

  // 2. How fast does compilation take?
  const samples = [];
  for (let i = 0; i < 60; i++) {
    const start = performance.now();
    await call("compile", [s1, "test", 2400]);
    if (i >= 10) samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  const p50 = samples[Math.floor(samples.length * 0.5)];

  // 3. How many claims fit in a 2400-token budget?
  const density = await call("compile", [s1, "project fact", 2400]);
  const claimsInBudget = density.manifest.claims.length;
  const tokensUsed = density.manifest.tokens;

  // 4. Do project-scoped claims survive a session switch?
  const s2 = { projectId, sessionId: "s2", entryIds: ["e2"] };
  await call("ingest", [s2, [{ entryId: "e2", text: "session 2", timestamp, role: "user" }]]);
  const survival = await call("compile", [s2, "persist", 2400]);
  const survived = survivalIds.filter((cid) =>
    survival.manifest.claims.some((c) => c.id === cid),
  ).length;

  await call("close", []);
  console.log(
    JSON.stringify(
      {
        suite: "remendra-v2",
        tests: {
          retrieval: { needlesFound, outOf: 5, pass: needlesFound === 5 },
          compilation: {
            p50Ms: Number(p50.toFixed(2)),
            claimsInBudget,
            tokensUsed,
            budget: 2400,
          },
          persistence: {
            survived,
            outOf: 50,
            note: survived < 50 ? "budget-limited, not data loss" : "all fit",
          },
        },
        pass: needlesFound === 5 && p50 < 500 && claimsInBudget > 0 && survived > 0,
      },
      null,
      2,
    ),
  );
} finally {
  await worker.terminate();
  rmSync(directory, { recursive: true, force: true });
}
