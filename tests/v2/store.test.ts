import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStore } from "../../src/v2/store.js";
import { compilePacket, contextAllowance } from "../../src/v2/compiler.js";
import { estimateTokens, equivalent } from "../../src/v2/text.js";
import { importLegacy } from "../../src/v2/migration.js";
import type { ClaimInput, Scope, Source } from "../../src/v2/types.js";

let dir: string, store: MemoryStore, scope: Scope;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "remendra-v2-"));
  store = new MemoryStore(join(dir, "memory.sqlite"));
  scope = { projectId: store.project("/project/a"), sessionId: "session-a", entryIds: [] };
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
});
function source(
  text = "Use PostgreSQL on port 5432",
  id = `entry-${scope.entryIds.length}`,
  extra: Partial<Source> = {},
): Source {
  scope.entryIds.push(id);
  const result = store.ingest(scope, [
    { entryId: id, text, role: "user", timestamp: "2026-09-06T12:00:00.000Z", ...extra },
  ]);
  return store.source(result.keys[0])!;
}
function remember(text: string, extra: Partial<ClaimInput> = {}, s = source(text)) {
  return store.record(
    scope,
    {
      text,
      kind: "fact",
      evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: s.text.length }],
      ...extra,
    },
    "user",
  ).claim;
}

it("persists source-attributed memory across restart and checks SQLite integrity", () => {
  const claim = remember("PostgreSQL stores project data");
  store.close();
  store = new MemoryStore(join(dir, "memory.sqlite"));
  expect(store.search({ scope, text: "PostgreSQL" })[0].claim.id).toBe(claim.id);
  expect(store.doctor().foreignKeys).toEqual([]);
  expect(store.doctor().integrity).toEqual({ quick_check: "ok" });
});
it("keeps project identity through explicit moves without merging unrelated projects", () => {
  expect(store.project("/project/a")).toBe(scope.projectId);
  expect(store.project("/renamed", scope.projectId)).toBe(scope.projectId);
  expect(store.project("/project/b")).not.toBe(scope.projectId);
  expect(() => store.project("/bad", "missing")).toThrow("not found");
});
it("preserves Cyrillic, Romanian, numbers and negation without fuzzy merging", () => {
  const a = remember("Не удалять базу данных");
  const b = remember("Удалять базу данных");
  const c = remember("Păstrează fișierele în Chișinău");
  expect(store.search({ scope, text: "данных" }).map((h) => h.claim.id)).toEqual(
    expect.arrayContaining([a.id, b.id]),
  );
  expect(store.search({ scope, text: "Chișinău" })[0].claim.id).toBe(c.id);
  expect(equivalent(a.text, b.text)).toBe(false);
  expect(equivalent("port 3000", "port 3001")).toBe(false);
});
it("rejects invented evidence, invalid spans, and sources from another branch", () => {
  const s = source();
  const base = {
    text: "a fact",
    kind: "fact" as const,
    evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: 10 }],
  };
  expect(() =>
    store.record(
      scope,
      { ...base, evidence: [{ ...base.evidence[0], hash: "wrong" }] },
      "observer",
    ),
  ).toThrow("Evidence");
  expect(() =>
    store.record(scope, { ...base, evidence: [{ ...base.evidence[0], end: 10000 }] }, "observer"),
  ).toThrow("span");
  expect(() => store.record({ ...scope, entryIds: [] }, base, "observer")).toThrow("Evidence");
  expect(store.status(scope).claims).toEqual({});
});
it("isolates projects, sessions, branches and opt-in user scope for current and historical reads", () => {
  let c = remember("Scoped project secret");
  expect(store.search({ scope: { ...scope, entryIds: [] }, text: "secret" })).toEqual([]);
  expect(store.search({ scope: { ...scope, sessionId: "other" }, text: "secret" })).toEqual([]);
  expect(
    store.search({ scope: { ...scope, projectId: store.project("/other") }, text: "secret" }),
  ).toEqual([]);
  c = store.change(scope, c.id, c.revision, "promote", "project");
  expect(
    store.search({ scope: { ...scope, sessionId: "other", entryIds: [] }, text: "secret" }),
  ).toHaveLength(1);
  store.change(scope, c.id, c.revision, "promote", "user");
  for (const mode of ["current", "history", "all"] as const)
    expect(store.search({ scope, text: "secret", mode })).toEqual([]);
  expect(store.search({ scope: { ...scope, includeUser: true }, text: "secret" })).toHaveLength(1);
});
it("requires explicit user authority to broaden scope", () => {
  const s = source();
  const evidence = [{ sourceKey: s.key, hash: s.hash, start: 0, end: 10 }];
  expect(() =>
    store.record(
      scope,
      { text: "Cross project preference", kind: "preference", visibility: "user", evidence },
      "observer",
    ),
  ).toThrow("Only the user");
});
it("corrects atomically and invalidates the transitive dependency graph", () => {
  const a = remember("Database is SQLite");
  const b = remember("Use SQLite migration", { dependsOn: [{ id: a.id, revision: a.revision }] });
  const c = remember("Apply the migration", { dependsOn: [{ id: b.id, revision: b.revision }] });
  const s = source("Database is PostgreSQL");
  const corrected = store.correct(scope, a.id, a.revision, {
    text: s.text,
    kind: "decision",
    evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: s.text.length }],
  }).claim;
  expect(store.claim(a.id, scope)?.status).toBe("superseded");
  expect(store.claim(b.id, scope)?.status).toBe("stale");
  expect(store.claim(c.id, scope)?.status).toBe("stale");
  expect(store.search({ scope }).map((h) => h.claim.id)).toEqual([corrected.id]);
  expect(corrected.supersedes).toEqual([a.id]);
});
it("rolls back a correction if the replacement has invalid evidence", () => {
  const a = remember("Original decision");
  const epoch = store.epoch();
  expect(() =>
    store.correct(scope, a.id, a.revision, {
      text: "Bad replacement",
      kind: "fact",
      evidence: [{ sourceKey: "missing", hash: "bad", start: 0, end: 2 }],
    }),
  ).toThrow();
  expect(store.claim(a.id, scope)).toEqual(a);
  expect(store.epoch()).toBe(epoch);
});
it("never revives corrected evidence when a background observer paraphrases it later", () => {
  const a = remember("Use SQLite for the database");
  const oldEvidence = a.evidence;
  const s = source("Use PostgreSQL for the database");
  store.correct(scope, a.id, a.revision, {
    text: s.text,
    kind: "decision",
    evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: s.text.length }],
  });
  const revived = store.record(
    scope,
    { text: "The project database engine is SQLite", kind: "fact", evidence: oldEvidence },
    "observer",
  ).claim;
  expect(revived.status).toBe("stale");
  expect(store.search({ scope, text: "SQLite" })).toEqual([]);
});
it("does not resurrect an erased source by importing a pre-erasure export", () => {
  const a = remember("A phrase to erase completely");
  const exported = store.exportData(scope);
  store.erase(scope, a.id, a.revision);
  expect(store.importData(scope, exported).claims).toBe(0);
  expect(store.search({ scope, mode: "all" })).toEqual([]);
});
it("accepts Blackhole v2 exports during the Remendra migration", () => {
  remember("A memory exported before the rebrand");
  const legacyExport = store
    .exportData(scope)
    .replace('"type":"remendra_export"', '"type":"blackhole_export"');
  expect(() => store.importData(scope, legacyExport)).not.toThrow();
});
it("detects contradictions when a user accepts an imported candidate", () => {
  const a = remember("Port 3000", { subject: "server", predicate: "port", value: "3000" });
  const b = store.record(
    scope,
    {
      text: "Port 3001",
      kind: "fact",
      subject: "server",
      predicate: "port",
      value: "3001",
      evidence: [],
    },
    "import",
  ).claim;
  expect(store.change(scope, b.id, b.revision, "accept").status).toBe("disputed");
  expect(store.claim(a.id, scope)?.status).toBe("disputed");
});
it("supports timezone-aware historical retrieval without leaking a future correction", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-06T09:00:00Z"));
  const a = remember("Old project decision");
  vi.setSystemTime(new Date("2026-09-06T11:00:00Z"));
  const s = source("New project decision");
  store.correct(scope, a.id, a.revision, {
    text: s.text,
    kind: "decision",
    evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: s.text.length }],
  });
  const past = store.search({ scope, asOf: "2026-09-06T13:00:00+03:00" });
  expect(past.map((h) => h.claim.text)).toEqual(["Old project decision"]);
});
it("uses revisions to reject stale writes", () => {
  const a = remember("A current fact");
  store.change(scope, a.id, a.revision, "pin");
  expect(() => store.change(scope, a.id, a.revision, "hide")).toThrow("Revision conflict");
});
it("disputes incompatible assertions instead of choosing the newest", () => {
  const a = remember("Use port 3000", { subject: "server", predicate: "port", value: "3000" });
  const b = remember("Use port 3001", { subject: "server", predicate: "port", value: "3001" });
  expect(store.claim(a.id, scope)?.status).toBe("disputed");
  expect(b.status).toBe("disputed");
  expect(store.search({ scope, text: "port" })).toHaveLength(0);
  expect(store.search({ scope, text: "port", mode: "history" })).toHaveLength(2);
});
it("keeps candidates from overriding established decisions", () => {
  const a = remember("Use port 3000", { subject: "server", predicate: "port", value: "3000" });
  const b = store.record(
    scope,
    {
      text: "Use port 3001",
      kind: "fact",
      subject: "server",
      predicate: "port",
      value: "3001",
      evidence: [],
    },
    "import",
  ).claim;
  expect(b.status).toBe("candidate");
  expect(store.claim(a.id, scope)?.status).toBe("active");
});
it("does not confuse nonoverlapping validity intervals or timezone offsets", () => {
  remember("Old port", {
    subject: "server",
    predicate: "port",
    value: "3000",
    validUntil: "2026-09-06T13:00:00+03:00",
  });
  const b = remember("New port", {
    subject: "server",
    predicate: "port",
    value: "3001",
    validFrom: "2026-09-06T10:00:00Z",
  });
  expect(b.status).toBe("active");
});
it("invalidates memories after a source replacement", () => {
  const s = source("Original evidence");
  const a = remember(s.text, {}, s);
  store.ingest(scope, [
    { entryId: s.entryId, text: "Edited evidence", role: "user", timestamp: s.timestamp },
  ]);
  expect(store.claim(a.id, scope)?.status).toBe("stale");
  expect(store.search({ scope, text: "Original" })).toEqual([]);
});
it("redacts secrets before indexing and skips configured sensitive paths", () => {
  const s = source("password=verysecret api_key=abc123 hello");
  expect(s.text).not.toContain("verysecret");
  const result = store.ingest(
    scope,
    [
      {
        entryId: "secret-file",
        text: "private text",
        role: "toolResult",
        target: "/project/.env",
        timestamp: s.timestamp,
      },
    ],
    [],
    [".env"],
  );
  expect(store.source(result.keys[0])?.text).toBe("");
  expect(store.sourceSearch(scope, "verysecret", true)).toEqual([]);
});
it("hides reversibly, retracts permanently, and suppresses unavailable dependencies", () => {
  let a = remember("Remember this fact");
  a = store.change(scope, a.id, a.revision, "hide");
  expect(store.search({ scope })).toEqual([]);
  a = store.change(scope, a.id, a.revision, "show");
  expect(store.search({ scope })).toHaveLength(1);
  a = store.change(scope, a.id, a.revision, "retract");
  expect(() => store.change(scope, a.id, a.revision, "show")).toThrow("Retired");
});
it("scrubs erased claims, history, vectors and shared-source dependents", () => {
  const s = source("Forget this distinctive sensitive phrase");
  const a = remember(s.text, {}, s);
  const b = remember("Derived detail", { dependsOn: [{ id: a.id, revision: a.revision }] });
  store.putVector(scope, a.id, a.revision, "test", [1, 0]);
  const erased = store.erase(scope, a.id, a.revision);
  expect(erased.claims).toBe(2);
  expect(store.claim(b.id, scope)).toBeUndefined();
  expect(store.source(s.key)?.text).toBe("");
  expect(store.exportData(scope)).not.toContain("distinctive sensitive phrase");
  store.ingest(scope, [{ entryId: s.entryId, text: s.text, role: s.role, timestamp: s.timestamp }]);
  expect(store.source(s.key)?.erased).toBe(true);
  expect(store.doctor().foreignKeys).toEqual([]);
});
it("exports only tombstones belonging to the requested project", () => {
  const a = remember("Erase a project fact");
  store.erase(scope, a.id, a.revision);
  const exported = store.exportData({ ...scope, projectId: store.project("/unrelated") });
  expect(exported).not.toContain("erased_source");
});
it("imports all distinct legacy records as candidates without fuzzy folding", () => {
  source("Current session anchor");
  const data = {
    data: {
      observations: [
        { id: "abcdef012345", content: "Не удалять данные" },
        { id: "abcdef012346", content: "Удалять данные" },
      ],
    },
  };
  expect(importLegacy(store, scope, JSON.stringify(data)).imported).toBe(2);
  expect(importLegacy(store, scope, JSON.stringify(data)).duplicates).toBe(2);
  expect(store.claim("abcdef012345", scope)?.text).toBe("Не удалять данные");
  expect(store.search({ scope })).toEqual([]);
});
it("restores a consistent backup and merges exports only as review candidates", () => {
  const a = remember("Exported factual memory");
  const backup = join(dir, "backup.sqlite");
  store.backup(backup);
  const restored = new MemoryStore(backup);
  expect(restored.claim(a.id, scope)?.text).toBe(a.text);
  restored.close();
  expect(readFileSync(backup).subarray(0, 15).toString()).toBe("SQLite format 3");
  const second = { ...scope, sessionId: "import-session" };
  const result = store.importData(second, store.exportData(scope));
  expect(result.claims).toBe(1);
  expect(store.search({ scope: second })).toEqual([]);
});
it("filters optional semantic matches by scope and revision", () => {
  const a = remember("Semantic memory");
  store.putVector(scope, a.id, a.revision, "local", [1, 0, 0]);
  expect(store.semantic(scope, "local", [1, 0, 0])[0].claim.id).toBe(a.id);
  expect(store.semantic({ ...scope, sessionId: "other" }, "local", [1, 0, 0])).toEqual([]);
  store.change(scope, a.id, a.revision, "pin");
  expect(store.semantic(scope, "local", [1, 0, 0])).toEqual([]);
});
it("requires two independent successful tool trials before procedure use and revokes on failure", () => {
  let p = remember("Run pnpm build before packaging", { kind: "procedure" });
  expect(store.search({ scope, text: "packaging" })).toEqual([]);
  for (let i = 0; i < 2; i++) {
    const s = source(`Build succeeded ${i}`, `trial-${i}`, {
      role: "toolResult",
      tool: "bash",
      isError: false,
    });
    p = store.trial(scope, {
      procedureId: p.id,
      expectedRevision: p.revision,
      sourceKey: s.key,
      outcome: "success",
      environment: "node24",
      note: "Build exit 0",
    });
  }
  expect(p.procedureState).toBe("promoted");
  expect(
    store.search({ scope: { ...scope, environment: "node24" }, text: "packaging" }),
  ).toHaveLength(1);
  expect(store.search({ scope: { ...scope, environment: "node26" }, text: "packaging" })).toEqual(
    [],
  );
  const failed = source("Build failed", "trial-fail", { role: "toolResult", isError: true });
  p = store.trial(scope, {
    procedureId: p.id,
    expectedRevision: p.revision,
    sourceKey: failed.key,
    outcome: "failure",
    environment: "node24",
    note: "Failure",
  });
  expect(p.procedureState).toBe("candidate");
});

describe("coverage and budget transactions", () => {
  it("leases chunks exclusively across simultaneous store connections", () => {
    source("One source");
    const other = new MemoryStore(store.file);
    try {
      expect(store.lease(scope, "one", 1000, 2000, 10000, 10000)).toBeDefined();
      expect(other.lease(scope, "two", 1000, 2000, 10000, 10000)).toBeUndefined();
    } finally {
      other.close();
    }
  });
  it("never advances unfinished coverage when extraction fails", () => {
    source("Coverage evidence");
    const job = store.lease(scope, "worker", 1000, 2000, 10000, 10000)!;
    expect(store.gaps(scope)[0].state).toBe("leased");
    store.failJob(job, "provider rejected", 100, 0);
    expect(store.gaps(scope)[0].state).toBe("pending");
    expect(store.status(scope).budget.spent).toBe(100);
  });
  it("marks successful empty extraction processed, and prevents duplicate commit", () => {
    source("No useful long-term information");
    const job = store.lease(scope, "worker", 1000, 2000, 10000, 10000)!;
    store.completeJob(job, scope, [], 200, 0);
    expect(store.gaps(scope)).toEqual([]);
    expect(store.status(scope).budget.reserved).toBe(0);
    expect(() => store.completeJob(job, scope, [], 200, 0)).toThrow("lease");
  });
  it("rolls back an entire observation batch if any citation is outside leased spans", () => {
    const s = source("Valid quote");
    const job = store.lease(scope, "worker", 1000, 2000, 10000, 10000)!;
    expect(() =>
      store.completeJob(
        job,
        scope,
        [
          {
            text: "Claim",
            kind: "fact",
            evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: 999 }],
          },
        ],
        100,
      ),
    ).toThrow("outside");
    expect(store.status(scope).claims).toEqual({});
    expect(store.gaps(scope)[0].state).toBe("leased");
  });
  it("reserves before dispatch and recovers crashed work with conservative billing", () => {
    source("A resumable source");
    const now = Date.now();
    const job = store.lease(scope, "crashed", 1000, 2000, 3000, 1000, now)!;
    expect(job).toBeDefined();
    expect(store.lease(scope, "second", 1000, 2000, 3000, 1000, now + 2000)).toBeUndefined();
    expect(store.status(scope).budget.spent).toBe(2000);
    expect(store.gaps(scope)[0].state).toBe("pending");
  });
  it("splits oversized source chunks while retaining exact gap coverage", () => {
    const s = source("Привет 👋 ".repeat(700));
    const job = store.lease(scope, "worker", 250, 500, 10000, 10000)!;
    expect(
      estimateTokens(job.chunks[0].source.text.slice(job.chunks[0].start, job.chunks[0].end)),
    ).toBeLessThanOrEqual(150);
    store.completeJob(job, scope, [], 100);
    const gaps = store.gaps(scope, 1000);
    expect(gaps[0].start).toBe(job.chunks[0].end);
    expect(gaps.reduce((n, g) => n + g.end - g.start, 0) + job.chunks[0].end).toBe(s.text.length);
  });
});

describe("bounded context", () => {
  it("measures the whole rendered packet and never truncates a selected claim", () => {
    for (let i = 0; i < 20; i++)
      remember(`Constraint ${i}: preserve every word in this atomic assertion.`, {
        kind: "constraint",
      });
    for (const budget of [0, 128, 512, 1000, 2400]) {
      const p = compilePacket(store, scope, "constraint", budget);
      expect(estimateTokens(p.text)).toBeLessThanOrEqual(budget);
      expect(p.manifest.tokens).toBe(estimateTokens(p.text));
      for (const ref of p.manifest.claims)
        expect(p.text).toContain(store.claim(ref.id, scope)!.text);
    }
  });
  it("keeps query-relevant facts and exposes coverage gaps and conflicts", () => {
    remember("Use PostgreSQL for billing", { kind: "decision" });
    source("Unprocessed source");
    const p = compilePacket(store, scope, "billing", 2400);
    expect(p.text).toContain("PostgreSQL");
    expect(p.manifest.gaps).toBeGreaterThan(0);
    expect(p.manifest.valid).toBe(true);
  });
  it("bounds context by headroom and output reserve", () => {
    expect(contextAllowance(2400, 10000, 9500, 1000)).toBe(0);
    expect(contextAllowance(2400, 10000, null, 1000)).toBe(400);
    expect(contextAllowance(2400, 128000, 1000, 8000)).toBe(2400);
  });
});
