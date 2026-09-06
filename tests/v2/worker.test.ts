import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryClient } from "../../src/v2/client.js";
import { BackgroundLearner } from "../../src/v2/learner.js";
import { DEFAULT_CONFIG } from "../../src/v2/config.js";
import { hash } from "../../src/v2/text.js";
import type { Scope } from "../../src/v2/types.js";

let directory: string, client: MemoryClient, scope: Scope;
beforeEach(async () => {
  directory = mkdtempSync(join(tmpdir(), "remendra-worker-"));
  client = new MemoryClient(
    join(directory, "memory.sqlite"),
    directory,
    pathToFileURL(resolve("dist/v2/worker.js")),
  );
  const projectId = await client.call("project", ["/project"]);
  scope = { projectId, sessionId: "session", entryIds: ["user-1"] };
  await client.call("ingest", [
    scope,
    [
      {
        entryId: "user-1",
        role: "user",
        text: "Use PostgreSQL for the primary database.",
        timestamp: "2026-09-06T00:00:00Z",
      },
    ],
  ]);
});
afterEach(async () => {
  await client.close();
  rmSync(directory, { recursive: true, force: true });
});

it("runs the actual built worker and compiles committed extraction", async () => {
  const learner = new BackgroundLearner(client);
  const result = await learner.run(
    scope,
    DEFAULT_CONFIG,
    async (request) => {
      const chunk = JSON.parse(request.input).chunks[0];
      return {
        text: JSON.stringify({
          claims: [
            { text: chunk.text, kind: "decision", evidence: [{ chunk: 0, quote: chunk.text }] },
          ],
        }),
        tokens: 123,
        dollars: 0,
      };
    },
    () => true,
  );
  expect(result).toContain("1 memories");
  const packet = await client.call("compile", [scope, "database", 2400]);
  expect(packet.text).toContain("PostgreSQL");
  expect(packet.manifest.gaps).toBe(0);
  expect((await client.call("status", [scope])).budget.spent).toBe(123);
});
it("retries malformed extraction and accounts for both attempts", async () => {
  let count = 0;
  const learner = new BackgroundLearner(client);
  await learner.run(
    scope,
    DEFAULT_CONFIG,
    async () => ({
      text: ++count === 1 ? "invalid JSON" : '{"claims":[]}',
      tokens: 100,
      dollars: 0,
    }),
    () => true,
  );
  expect(count).toBe(2);
  expect((await client.call("status", [scope])).budget.spent).toBe(200);
  expect(await client.call("gaps", [scope])).toEqual([]);
});
it("cancels background work immediately and leaves unfinished chunks visible", async () => {
  const learner = new BackgroundLearner(client);
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const running = learner.run(
    scope,
    DEFAULT_CONFIG,
    async () => {
      started();
      return new Promise(() => {});
    },
    () => true,
  );
  await ready;
  const start = Date.now();
  learner.cancel();
  await running;
  expect(Date.now() - start).toBeLessThan(1000);
  expect((await client.call("gaps", [scope]))[0].state).toBe("pending");
});
it("discards results when the session generation changes", async () => {
  const learner = new BackgroundLearner(client);
  let current = true;
  await learner.run(
    scope,
    DEFAULT_CONFIG,
    async () => {
      current = false;
      return { text: '{"claims":[]}', tokens: 20 };
    },
    () => current,
  );
  expect((await client.call("gaps", [scope]))[0].state).toBe("pending");
});
it("enforces a daily token reservation before a provider is called", async () => {
  const provider = vi.fn();
  const learner = new BackgroundLearner(client);
  await learner.run(scope, { ...DEFAULT_CONFIG, dailyTokenBudget: 1 }, provider, () => true);
  expect(provider).not.toHaveBeenCalled();
});
it("recovers after a hard worker deadline and does not hang the main thread", async () => {
  // A deterministic busy worker stands in for pathological regex or filesystem work.
  const file = join(directory, "blocked.mjs");
  writeFileSync(
    file,
    'import { parentPort } from "node:worker_threads"; parentPort.on("message", () => { while (true) {} });',
  );
  const blocked = new MemoryClient(join(directory, "other.sqlite"), directory, pathToFileURL(file));
  const start = Date.now();
  await expect(blocked.call("doctor", [], 100)).rejects.toThrow("exceeded");
  expect(Date.now() - start).toBeLessThan(1500);
  await blocked.close();
  expect((await client.call("doctor", [])).foreignKeys).toEqual([]);
});
it("preserves tool call/result adjacency while exposing original #N recall", async () => {
  const file = join(directory, "session.jsonl");
  writeFileSync(
    file,
    [
      { type: "session", id: "session" },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        message: { role: "user", content: "Original transcript message" },
      },
      {
        type: "message",
        id: "other-branch",
        parentId: null,
        message: { role: "user", content: "Private alternate branch" },
      },
    ]
      .map((v) => JSON.stringify(v))
      .join("\n"),
  );
  expect(await client.call("recall", [scope, { query: "#0" }, file])).toContain(
    "Original transcript message",
  );
  await expect(client.call("recall", [scope, { query: "#1" }, file])).rejects.toThrow("outside");
  expect(await client.call("recall", [scope, { query: "#1", scope: "all" }, file])).toContain(
    "Private alternate branch",
  );
});
it("accepts source-backed manual records through the same RPC validation", async () => {
  const text = "Use PostgreSQL for the primary database.",
    timestamp = "2026-09-06T00:00:00Z";
  const digest = hash(JSON.stringify(["user", text, timestamp, undefined, undefined, undefined]));
  const key = hash(JSON.stringify([scope.projectId, scope.sessionId, "user-1", digest]));
  const result = await client.call("record", [
    scope,
    {
      text,
      kind: "decision",
      evidence: [{ sourceKey: key, hash: digest, start: 0, end: text.length }],
    },
    "user",
  ]);
  expect(result.claim.status).toBe("active");
});
