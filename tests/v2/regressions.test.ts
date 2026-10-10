import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MemoryClient } from "../../src/v2/client.js";
import { BackgroundLearner } from "../../src/v2/learner.js";
import { DEFAULT_CONFIG } from "../../src/v2/config.js";
import { abortable, parseObservations } from "../../src/v2/observer.js";
import type { Job, Scope } from "../../src/v2/types.js";

/** Collect unhandled rejections for the duration of a test. */
function trackUnhandled(): { list: unknown[]; stop: () => void } {
  const list: unknown[] = [];
  const handler = (reason: unknown) => list.push(reason);
  process.on("unhandledRejection", handler);
  return { list, stop: () => process.off("unhandledRejection", handler) };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe("abortable", () => {
  it("does not leak an unhandled rejection when the signal is already aborted", async () => {
    const tracker = trackUnhandled();
    try {
      const controller = new AbortController();
      controller.abort(new Error("Session, branch, or memory changed"));
      // The provider call was already created and rejects on its own, like Pi's complete() does.
      const call = Promise.reject(new Error("Session, branch, or memory changed"));
      await expect(abortable(call, controller.signal)).rejects.toThrow("Session, branch");
      await tick();
      expect(tracker.list).toEqual([]);
    } finally {
      tracker.stop();
    }
  });
});

describe("parseObservations", () => {
  const job: Job = {
    id: "job",
    owner: "owner",
    projectId: "p",
    sessionId: "s",
    reservedTokens: 100,
    expiresAt: Date.now() + 1000,
    chunks: [
      {
        id: 1,
        start: 0,
        end: 60,
        source: {
          key: "k",
          hash: "h",
          role: "user",
          text: "Never delete production data. Use PostgreSQL 16.",
        },
      },
    ],
  } as unknown as Job;
  const claim = (text: string, quote: string, kind = "fact") => ({
    text,
    kind,
    evidence: [{ chunk: 0, quote }],
  });

  it("keeps the first 16 claims instead of failing the batch when the model returns more", () => {
    const claims = Array.from({ length: 20 }, (_, i) =>
      claim(`Claim ${i}`, "Never delete production data."),
    );
    const parsed = parseObservations(JSON.stringify({ claims }), job);
    expect(parsed.length).toBe(16);
  });

  it("skips a malformed claim and keeps the valid ones", () => {
    const text = JSON.stringify({
      claims: [
        claim("Use PostgreSQL 16", "Use PostgreSQL 16."),
        { text: "", kind: "fact", evidence: [] },
        { kind: "nonsense" },
      ],
    });
    const parsed = parseObservations(text, job);
    expect(parsed.map((c) => c.text)).toEqual(["Use PostgreSQL 16"]);
  });

  it("accepts a bare array of claims", () => {
    const parsed = parseObservations(
      JSON.stringify([claim("Use PostgreSQL 16", "Use PostgreSQL 16.")]),
      job,
    );
    expect(parsed.length).toBe(1);
  });

  it("still rejects output that is not JSON at all", () => {
    expect(() => parseObservations("I cannot help with that", job)).toThrow();
  });
});

describe("BackgroundLearner cancellation", () => {
  let directory: string, client: MemoryClient, scope: Scope;
  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "remendra-regress-"));
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

  it("cancelled while the job is being leased: no provider call, no crash, nothing charged", async () => {
    const tracker = trackUnhandled();
    try {
      const learner = new BackgroundLearner(client);
      // Cancel exactly while the lease RPC is in flight, as session_shutdown or a new prompt does.
      const original = client.call.bind(client);
      client.call = (async (method: string, args: unknown[], timeout?: number) => {
        const result = await original(method as never, args as never, timeout);
        if (method === "lease") learner.cancel("Session, branch, or memory changed");
        return result;
      }) as typeof client.call;
      const provider = vi.fn(async ({ signal }: { signal: AbortSignal }) => {
        if (signal.aborted) throw new Error("Session, branch, or memory changed");
        return { text: '{"claims":[]}', tokens: 1 };
      });
      await learner.run(scope, DEFAULT_CONFIG, provider, () => true);
      await tick();
      client.call = original;
      expect(provider).not.toHaveBeenCalled();
      expect(tracker.list).toEqual([]);
      const status = await client.call("status", [scope]);
      expect(status.budget.spent).toBe(0);
      expect(status.budget.reserved).toBe(0);
    } finally {
      tracker.stop();
    }
  });

  it("cancelled mid-call: charges the input estimate, not the whole reservation", async () => {
    const learner = new BackgroundLearner(client);
    let started!: () => void;
    const ready = new Promise<void>((r) => (started = r));
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
    learner.cancel("Foreground work has priority");
    await running;
    const { budget } = await client.call("status", [scope]);
    expect(budget.reserved).toBe(0);
    expect(budget.spent).toBeGreaterThan(0);
    expect(budget.spent).toBeLessThan(
      DEFAULT_CONFIG.observerInputTokens + DEFAULT_CONFIG.observerOutputTokens,
    );
  });
});

describe("transcript search (searchEntries)", () => {
  const load = () => import("../../src/core/search-entries.js");
  const msgs = [
    { role: "user", content: "We chose postgres because of JSONB support", timestamp: 1 },
    { role: "user", content: "Deploy runs on Hetzner", timestamp: 2 },
  ];
  const entries = msgs.map((m, index) => ({
    index,
    id: `e${index}`,
    role: "user",
    summary: m.content,
  }));

  it("treats a natural question with ? and . as words, not a regex", async () => {
    const { searchEntries } = await load();
    const hits = searchEntries(entries as never, msgs as never, "why did we choose postgres?");
    expect(hits.map((h) => h.id)).toEqual(["e0"]);
  });

  it("uses a regex when asked: recall mode regex, or /pattern/", async () => {
    const { searchEntries } = await load();
    expect(
      searchEntries(entries as never, msgs as never, "Het.ner", undefined, "hybrid", true).map(
        (h) => h.id,
      ),
    ).toEqual(["e1"]);
    expect(
      searchEntries(entries as never, msgs as never, "/post(gres|gis)/").map((h) => h.id),
    ).toEqual(["e0"]);
  });
});

describe("Pi session files (index-sessions)", () => {
  const load = () => import("../../src/v2/sessions.js");
  const file =
    [
      {
        type: "session",
        version: 3,
        id: "sess-1",
        timestamp: "2026-10-10T10:00:00.000Z",
        cwd: "/home/u/app",
      },
      {
        type: "message",
        id: "s0",
        parentId: null,
        timestamp: "2026-10-10T10:00:00.000Z",
        message: { role: "system", content: "", sections: { preamble: "You are an expert" } },
      },
      {
        type: "message",
        id: "m1",
        parentId: "s0",
        timestamp: "2026-10-10T10:00:01.000Z",
        message: { role: "user", content: "Deploy the API to Hetzner fsn1 please" },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-10-10T10:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "secret plan" },
            { type: "text", text: "Deploying to Hetzner fsn1 now." },
          ],
        },
      },
      {
        type: "message",
        id: "m3",
        parentId: "m2",
        timestamp: "2026-10-10T10:00:03.000Z",
        message: {
          role: "toolResult",
          toolName: "bash",
          toolCallId: "c",
          content: [{ type: "text", text: "deployment finished ok" }],
          isError: false,
        },
      },
      {
        type: "custom",
        id: "x1",
        parentId: "m3",
        timestamp: "2026-10-10T10:00:04.000Z",
        customType: "ext",
        data: {},
      },
    ]
      .map((l) => JSON.stringify(l))
      .join("\n") + '\n{"type":"message","id":"partial';

  it("reads the current Pi format: header, user/assistant/tool text; skips system, thinking, custom and a partial line", async () => {
    const { parseSessionFile } = await load();
    const s = parseSessionFile(file);
    expect(s.id).toBe("sess-1");
    expect(s.cwd).toBe("/home/u/app");
    expect(s.sources.map((x) => [x.entryId, x.role])).toEqual([
      ["m1", "user"],
      ["m2", "assistant"],
      ["m3", "toolResult"],
    ]);
    expect(s.sources[1].text).toBe("Deploying to Hetzner fsn1 now.");
    expect(s.sources[2].tool).toBe("bash");
  });

  it("only indexes sessions of this project (its folder or below)", async () => {
    const { sessionInProject } = await load();
    expect(sessionInProject("/home/u/app", "/home/u/app")).toBe(true);
    expect(sessionInProject("/home/u/app/web", "/home/u/app")).toBe(true);
    expect(sessionInProject("/home/u/app2", "/home/u/app")).toBe(false);
    expect(sessionInProject("/home/u", "/home/u/app")).toBe(false);
    expect(sessionInProject(undefined, "/home/u/app")).toBe(false);
  });
});

describe("excludedPaths", () => {
  it("excludes a bash command that reads a sensitive file, and its output", async () => {
    const { sourceInputs } = await import("../../src/v2/sources.js");
    const entries = [
      {
        type: "message",
        id: "a",
        parentId: null,
        timestamp: "2026-10-10T10:00:00.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "toolCall", id: "c1", name: "bash", arguments: { command: "cat .env" } },
          ],
        },
      },
      {
        type: "message",
        id: "r",
        parentId: "a",
        timestamp: "2026-10-10T10:00:01.000Z",
        message: {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "bash",
          content: [{ type: "text", text: "AWS_SECRET_ACCESS_KEY=abc123" }],
          isError: false,
        },
      },
    ];
    const inputs = sourceInputs(entries as never, [".env"]);
    expect(inputs[0].text).toContain("[sensitive path excluded]");
    expect(inputs[0].text).not.toContain("cat .env");
    expect(inputs[1].target).toBe("cat .env"); // the store drops text whose target is excluded
  });
});
