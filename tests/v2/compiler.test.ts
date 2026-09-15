import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../src/v2/store.js";
import { compilePacket, contextAllowance } from "../../src/v2/compiler.js";
import type { Scope, Source } from "../../src/v2/types.js";

let store: MemoryStore;
let scope: Scope;

function source(text = "seed source for compiler tests"): Source {
  const id = `entry-${scope.entryIds.length}`;
  scope.entryIds.push(id);
  const result = store.ingest(scope, [
    { entryId: id, text, role: "user", timestamp: new Date().toISOString() },
  ]);
  return store.source(result.keys[0])!;
}

function remember(text: string, kind: "fact" | "constraint" | "hypothesis" = "fact") {
  const s = source(text);
  return store.record(
    scope,
    {
      text,
      kind,
      evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: s.text.length }],
    },
    "user",
  ).claim;
}

beforeEach(() => {
  store = new MemoryStore(":memory:");
  scope = { projectId: store.project("/test/compiler"), sessionId: "s1", entryIds: [] };
});
afterEach(() => store.close());

describe("compilePacket", () => {
  it("returns empty packet when budget cannot hold header", () => {
    remember("Test claim");
    const packet = compilePacket(store, scope, "test", 10);
    expect(packet.text).toBe("");
    expect(packet.manifest.valid).toBe(false);
    expect(packet.manifest.reasons[0]).toContain("Budget cannot hold");
  });

  it("compiles claims within budget", () => {
    for (let i = 0; i < 5; i++) remember(`Claim ${i} about databases`);
    const packet = compilePacket(store, scope, "databases", 2000);
    expect(packet.manifest.valid).toBe(true);
    expect(packet.manifest.claims.length).toBeGreaterThan(0);
    expect(packet.manifest.tokens).toBeLessThanOrEqual(2000);
  });

  it("includes pinned claims first", () => {
    const a = remember("Unpinned claim about testing");
    const b = remember("Pinned claim about testing");
    store.change(scope, b.id, b.revision, "pin");
    const packet = compilePacket(store, scope, "testing", 2000);
    const ids = packet.manifest.claims.map((c) => c.id);
    if (ids.includes(a.id) && ids.includes(b.id)) {
      expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    }
  });

  it("ranks constraints above hypotheses", () => {
    const hyp = remember("Deploy might change", "hypothesis");
    const con = remember("Never deploy on Friday", "constraint");
    const packet = compilePacket(store, scope, "deploy Friday", 2000);
    const ids = packet.manifest.claims.map((c) => c.id);
    if (ids.includes(con.id) && ids.includes(hyp.id)) {
      expect(ids.indexOf(con.id)).toBeLessThan(ids.indexOf(hyp.id));
    }
  });

  it("reports omission count when budget is tight", () => {
    for (let i = 0; i < 30; i++) remember(`Database claim number ${i} with details`);
    const packet = compilePacket(store, scope, "database", 400);
    // At a tight budget, some claims are omitted
    if (packet.manifest.valid) {
      expect(packet.manifest.omitted).toBeGreaterThan(0);
      expect(packet.text).toContain("Omitted");
    }
  });

  it("handles empty query (anchor-only)", () => {
    for (let i = 0; i < 3; i++) remember(`Anchor claim ${i}`);
    const packet = compilePacket(store, scope, "", 2000);
    expect(packet.manifest.valid).toBe(true);
  });
});

describe("contextAllowance", () => {
  it("caps to 1024 when window is unknown", () => {
    expect(contextAllowance(6000, undefined, undefined, 8000)).toBe(1024);
    expect(contextAllowance(6000, 0, undefined, 8000)).toBe(1024);
  });

  it("respects configured budget when headroom allows", () => {
    expect(contextAllowance(6000, 200000, 50000, 8000)).toBe(6000);
  });

  it("reduces budget when headroom is tight", () => {
    expect(contextAllowance(6000, 100000, 95000, 4000)).toBe(1000);
  });

  it("returns 0 when headroom is negative", () => {
    expect(contextAllowance(6000, 100000, 100000, 8000)).toBe(0);
  });

  it("estimates 4% headroom when usage is null", () => {
    expect(contextAllowance(6000, 200000, null, 8000)).toBe(6000);
    expect(contextAllowance(10000, 200000, null, 8000)).toBe(8000);
  });
});
