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

  it("finds the answer when the model wraps it in prose", () => {
    const wrapped =
      "Here are the memories:\n" +
      JSON.stringify({ claims: [claim("Use PostgreSQL 16", "Use PostgreSQL 16.")] }) +
      "\nLet me know if you need more.";
    expect(parseObservations(wrapped, job).length).toBe(1);
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
    // A cancellation is not a failure: it never feeds the "learning degraded" count.
    expect(await running).toBe("Learning paused; 0 memories committed");
    const { budget } = await client.call("status", [scope]);
    expect(budget.reserved).toBe(0);
    expect(budget.spent).toBeGreaterThan(0);
    expect(budget.spent).toBeLessThan(
      DEFAULT_CONFIG.observerInputTokens + DEFAULT_CONFIG.observerOutputTokens,
    );
  });

  it("gives user text no claim cited a second look in the next batch, without a request of its own", async () => {
    const learner = new BackgroundLearner(client);
    const seen: string[] = [];
    const answers = ['{"claims":[]}'];
    const provider = vi.fn(async ({ input }: { input: string }) => {
      seen.push(input);
      return { text: answers.shift() ?? '{"claims":[]}', tokens: 10 };
    });
    // First answer cites nothing: the chunk is set aside, and nothing is leased alone for it.
    await learner.run(scope, DEFAULT_CONFIG, provider, () => true);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(await learner.run(scope, DEFAULT_CONFIG, provider, () => true)).toBe(
      "No eligible work or daily budget exhausted",
    );
    expect(provider).toHaveBeenCalledTimes(1);
    // New work arrives: the set-aside text rides along and this time is learned.
    const next = { ...scope, entryIds: [...scope.entryIds, "user-2"] };
    await client.call("ingest", [
      next,
      [{ entryId: "user-2", role: "user", text: "Say hello.", timestamp: "2026-09-06T00:01:00Z" }],
    ]);
    answers.push(
      JSON.stringify({
        claims: [
          {
            text: "PostgreSQL is the primary database",
            kind: "decision",
            evidence: [{ chunk: 0, quote: "Use PostgreSQL for the primary database." }],
          },
        ],
      }),
    );
    expect(await learner.run(next, DEFAULT_CONFIG, provider, () => true)).toMatch(/^Learned 1/);
    expect(provider).toHaveBeenCalledTimes(2);
    expect(seen[1]).toContain("Use PostgreSQL");
    expect(seen[1]).toContain("Say hello.");
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

describe("recall arguments from small models", () => {
  it("maps the near-miss values seen in real sessions instead of failing the call", async () => {
    const { normalizeRecallArgs } = await import("../../src/v2/recall-args.js");
    expect(normalizeRecallArgs({ query: "db", mode: "claims" })).toEqual({
      query: "db",
      mode: "memory",
    });
    expect(normalizeRecallArgs({ mode: "all" })).toEqual({ mode: "memory", scope: "all" });
    expect(normalizeRecallArgs({ scope: "project" })).toEqual({ scope: "all" });
    expect(normalizeRecallArgs({ scope: "user" })).toEqual({ scope: "all" });
    expect(normalizeRecallArgs({ scope: "memory", mode: "nonsense" })).toEqual({});
    expect(normalizeRecallArgs({ mode: "History", page: "2", expand: "3, 4" })).toEqual({
      mode: "history",
      page: 2,
      expand: [3, 4],
    });
    expect(normalizeRecallArgs(null)).toEqual({});
  });
});

describe("observer output from thinking models", () => {
  it("takes the last valid claims object, skipping the prompt's sketch and drafts", async () => {
    const { extractClaimsJson } = await import("../../src/v2/observer.js");
    const reasoning =
      'The format is {"claims": [...]}. Draft: {"claims": [{"text": "x"' +
      ' wait, fix the quote. Final: {"claims": [{"text": "Use {braces} and \\"quotes\\"", "kind": "fact", "evidence": []}]} done.';
    expect(JSON.parse(extractClaimsJson(reasoning)).claims[0].text).toBe(
      'Use {braces} and "quotes"',
    );
    expect(extractClaimsJson("no answer here")).toBe("");
  });

  it("reads Pi thinking blocks, which keep their text in `thinking`", async () => {
    const { thinkingText } = await import("../../src/v2/observer.js");
    expect(
      thinkingText([
        { type: "thinking", thinking: "first" },
        { type: "text", text: "ignored" },
        { type: "thinking", thinking: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("turns thinking off only for OpenAI-compatible reasoning models", async () => {
    const { thinkingOffPayload } = await import("../../src/v2/observer.js");
    const hook = thinkingOffPayload({ api: "openai-completions", reasoning: true })!;
    expect(hook({ model: "m" })).toEqual({ model: "m", reasoning_effort: "none" });
    expect(hook({ reasoning_effort: "high" })).toBeUndefined();
    const mapped = thinkingOffPayload({
      api: "openai-completions",
      reasoning: true,
      thinkingLevelMap: { off: "minimal" },
    })!;
    expect(mapped({})).toEqual({ reasoning_effort: "minimal" });
    expect(
      thinkingOffPayload({
        api: "openai-completions",
        reasoning: true,
        thinkingLevelMap: { off: null },
      }),
    ).toBeUndefined();
    expect(thinkingOffPayload({ api: "anthropic-messages", reasoning: true })).toBeUndefined();
    expect(thinkingOffPayload({ api: "openai-completions", reasoning: false })).toBeUndefined();
  });
});

describe("memory output", () => {
  const claim = {
    id: "c1",
    revision: 2,
    kind: "fact",
    text: "The API runs in fsn1",
    visibility: "project",
    status: "active",
    verification: "source_checked",
    projectId: "p".repeat(36),
    sessionId: "s".repeat(36),
    anchor: "a1",
    evidence: [{ sourceKey: "k".repeat(64), hash: "h".repeat(64), start: 0, end: 20 }],
    supersedes: [],
    dependsOn: [],
    pinned: true,
    hidden: false,
  } as never;

  it("gives the model the packet's compact record, without internal ids and hashes", async () => {
    const { claimRecord } = await import("../../src/v2/compiler.js");
    const record = JSON.parse(claimRecord(claim, ["fts"]));
    expect(record).toEqual({
      id: "c1",
      revision: 2,
      kind: "fact",
      text: "The API runs in fsn1",
      scope: "project",
      verification: "source_checked",
      sources: [["k".repeat(64), 0, 20]],
      why: ["fts"],
    });
  });

  it("shows people one readable entry per memory", async () => {
    const { formatHits } = await import("../../src/v2/extension.js");
    expect(formatHits([{ claim, score: 1, reasons: [] }], "current memories")).toBe(
      "c1  fact · active · project · pinned\n  The API runs in fsn1",
    );
    expect(formatHits([], "current memories")).toBe("No current memories match.");
  });
});

describe("packet placement", () => {
  const msgs = [
    { role: "user", timestamp: 1 },
    { role: "assistant", timestamp: 2 },
    { role: "user", timestamp: 3 },
  ];
  const packet = { role: "custom", timestamp: 9 };

  it("goes before the last user message and reports it as the anchor", async () => {
    const { placePacket } = await import("../../src/v2/extension.js");
    const placed = placePacket(msgs, packet);
    expect(placed.messages.map((m) => m.timestamp)).toEqual([1, 2, 9, 3]);
    expect(placed.anchor).toBe(3);
  });

  it("stays at its earlier anchor so the conversation after it keeps its cache", async () => {
    const { placePacket } = await import("../../src/v2/extension.js");
    expect(placePacket(msgs, packet, 1).messages.map((m) => m.timestamp)).toEqual([9, 1, 2, 3]);
    // The anchor was compacted away: fall back to the last user message.
    expect(placePacket(msgs, packet, 42).anchor).toBe(3);
    expect(placePacket([{ role: "assistant", timestamp: 2 }], packet).messages[0]).toBe(packet);
  });
});

describe("recall output is not a learning source", () => {
  it("marks the recall tool's result to skip learning and leaves other tools alone", async () => {
    const { sourceInputs } = await import("../../src/v2/sources.js");
    const result = (id: string, toolName: string) => ({
      type: "message",
      id,
      parentId: null,
      timestamp: "2026-09-06T00:00:00Z",
      message: {
        role: "toolResult",
        toolCallId: id,
        toolName,
        content: [{ type: "text", text: "x" }],
        isError: false,
      },
    });
    const [recall, bash] = sourceInputs([result("r", "recall"), result("b", "bash")] as never);
    expect(recall.skipLearning).toMatch(/recall output/);
    expect(bash.skipLearning).toBeUndefined();
  });
});

describe("search cues from the model", () => {
  it("reads cue lists in the shapes small models write", async () => {
    const { parseCues } = await import("../../src/v2/observer.js");
    const text = 'Sure: {"cues": [["cloud provider", "hosting"], "backend, server", 42]}';
    expect(parseCues(text, 4)).toEqual([
      ["cloud provider", "hosting"],
      ["backend", "server"],
      [],
      [],
    ]);
    expect(() => parseCues("no json", 1)).toThrow();
  });

  it("keeps an observer claim whose cues are one comma-separated string", () => {
    const job = {
      chunks: [
        {
          id: 1,
          start: 0,
          end: 30,
          source: { key: "k", hash: "h", role: "user", text: "We deploy the API to Hetzner." },
        },
      ],
    } as never;
    const [claim] = parseObservations(
      JSON.stringify({
        claims: [
          {
            text: "API on Hetzner",
            kind: "fact",
            cues: "cloud provider, hosting",
            evidence: [{ chunk: 0, quote: "deploy the API to Hetzner" }],
          },
        ],
      }),
      job,
    );
    expect(claim.cues).toEqual(["cloud provider", "hosting"]);
  });
});

describe("broken cue JSON", () => {
  it("salvages one list per memory from mismatched brackets, never misaligned", async () => {
    const { parseCues } = await import("../../src/v2/observer.js");
    const broken =
      '```json\n{"cues": [["where is the API hosted", "cloud provider"]}], ["db backup rule"]]}\n```';
    expect(parseCues(broken, 2)).toEqual([
      ["where is the API hosted", "cloud provider"],
      ["db backup rule"],
    ]);
    expect(() => parseCues(broken, 3)).toThrow();
  });
});

describe("hybrid memory ranking", () => {
  const hit = (id: string, score: number) => ({ claim: { id } as never, score, reasons: [] });
  it("orders by similarity, gives word matches a small bonus, and drops unrelated memories", async () => {
    const { rankHybrid } = await import("../../src/v2/extension.js");
    const ranked = rankHybrid(
      [hit("b", 9), hit("z", 5)], // keyword hits (bm25 scores are ignored)
      [hit("a", 0.6), hit("b", 0.58), hit("c", 0.3), hit("d", 0.1)],
    );
    expect(ranked.map((h) => (h.claim as { id: string }).id)).toEqual(["b", "a", "c", "z"]);
    expect(ranked[0].reasons).toEqual(["similarity 0.58", "word match"]);
    expect(ranked.at(-1)!.reasons).toEqual(["word match"]);
  });
});

describe("restated memories", () => {
  const known = [
    { n: 0, text: "The API is deployed to Hetzner, region fsn1." },
    { n: 1, text: "The frontend uses SvelteKit." },
    { n: 2, text: "Database migrations must be run only after a fresh backup." },
    { n: 3, text: "Use PostgreSQL 16." },
    { n: 4, text: "Удалять старые логи каждую неделю." },
  ];
  const claim = (text: string, mark?: number) => ({
    text,
    kind: "fact" as const,
    evidence: [],
    known: mark,
  });
  it("drops restatements the observer marked, and ones that only reuse a memory's words", async () => {
    const { dropRestatements } = await import("../../src/v2/observer.js");
    const { kept, dropped } = dropRestatements(
      [
        claim("The frontend framework is SvelteKit.", 1),
        claim("The API is deployed in the Hetzner region fsn1"),
      ],
      known,
    );
    expect(kept).toEqual([]);
    expect(dropped).toBe(2);
  });
  it("keeps changes, new names, other nouns, reversed order, negation and new numbers", async () => {
    const { dropRestatements } = await import("../../src/v2/observer.js");
    const texts = [
      ["We moved the API from fsn1 to nbg1.", 0],
      ["The SvelteKit frontend is hosted on Cloudflare Pages.", 1],
      ["The backend uses SvelteKit.", undefined],
      ["Run migrations before the backup.", undefined],
      ["Database migrations don't need a fresh backup.", 2],
      ["Use PostgreSQL 15.", 3],
      ["Не удалять старые логи каждую неделю.", 4],
    ] as const;
    const { kept } = dropRestatements(
      texts.map(([t, m]) => claim(t, m)),
      known,
    );
    expect(kept.map((c) => c.text)).toEqual(texts.map(([t]) => t));
    expect(kept.every((c) => !("known" in c))).toBe(true);
  });
});
