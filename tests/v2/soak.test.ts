import { describe, it, expect, afterEach } from "vitest";
import { MemoryStore } from "../../src/v2/store.js";
import type { Scope } from "../../src/v2/types.js";

describe("soak: sustained growth", { timeout: 120_000 }, () => {
  let store: MemoryStore;

  afterEach(() => {
    try {
      store?.close();
    } catch {
      /* already closed */
    }
  });

  it("handles 2000 claims across 20 simulated sessions with stable search latency", () => {
    store = new MemoryStore(":memory:");
    const timings: number[] = [];
    const topics = [
      "database migration strategy",
      "API authentication tokens",
      "PostgreSQL configuration tuning",
      "deployment pipeline automation",
      "error handling patterns",
    ];

    for (let session = 0; session < 20; session++) {
      const sessionScope: Scope = {
        projectId: store.project("/test/soak"),
        sessionId: `s${session}`,
        entryIds: [],
      };

      // Ingest one source per session
      const entryId = `e-${session}`;
      sessionScope.entryIds.push(entryId);
      const result = store.ingest(sessionScope, [
        {
          entryId,
          role: "user",
          text: `Session ${session}: working on ${topics[session % topics.length]}. This involves multiple steps and careful planning for the project infrastructure.`,
          timestamp: new Date(Date.now() - (20 - session) * 86400000).toISOString(),
        },
      ]);
      const s = store.source(result.keys[0])!;

      // Record 100 claims per session
      for (let i = 0; i < 100; i++) {
        const topic = topics[(session * 100 + i) % topics.length];
        store.record(
          sessionScope,
          {
            text: `Session ${session} claim ${i}: ${topic} requires careful consideration`,
            kind: (["fact", "decision", "constraint", "preference"] as const)[i % 4],
            evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: Math.min(50, s.text.length) }],
          },
          "observer",
        );
      }

      // Measure search latency at this growth point
      const t0 = performance.now();
      store.search({ scope: sessionScope, text: "database migration", limit: 20 });
      timings.push(performance.now() - t0);
    }

    // Search should stay under 200ms even at 2000 claims
    const sorted = [...timings].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    expect(p95).toBeLessThan(200);

    expect(store.doctor().foreignKeys).toEqual([]);
  });

  it("epoch counter increments with records", () => {
    store = new MemoryStore(":memory:");
    const scope: Scope = {
      projectId: store.project("/test/epoch"),
      sessionId: "s1",
      entryIds: [],
    };

    const entryId = "e1";
    scope.entryIds.push(entryId);
    const result = store.ingest(scope, [
      { entryId, role: "user", text: "source text", timestamp: new Date().toISOString() },
    ]);
    const s = store.source(result.keys[0])!;

    const initial = store.status(scope).epoch;
    for (let i = 0; i < 50; i++) {
      store.record(
        scope,
        {
          text: `Epoch test claim ${i} with unique content`,
          kind: "fact",
          evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: s.text.length }],
        },
        "observer",
      );
    }

    expect(store.status(scope).epoch).toBeGreaterThan(initial);
    expect(store.doctor().foreignKeys).toEqual([]);
  });

  it("search results are bounded and consistent at scale", () => {
    store = new MemoryStore(":memory:");
    const scope: Scope = {
      projectId: store.project("/test/scale"),
      sessionId: "s1",
      entryIds: [],
    };

    const entryId = "e1";
    scope.entryIds.push(entryId);
    const result = store.ingest(scope, [
      { entryId, role: "user", text: "database configuration source text", timestamp: new Date().toISOString() },
    ]);
    const s = store.source(result.keys[0])!;

    for (let i = 0; i < 300; i++) {
      store.record(
        scope,
        {
          text: `Database configuration claim ${i}: set max_connections to ${100 + i}`,
          kind: "fact",
          evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: s.text.length }],
        },
        "observer",
      );
    }

    const hits = store.search({ scope, text: "database configuration", limit: 20 });
    expect(hits.length).toBeLessThanOrEqual(20);
    expect(hits.length).toBeGreaterThan(0);

    const bigHits = store.search({ scope, text: "database", limit: 200 });
    expect(bigHits.length).toBeLessThanOrEqual(200);

    for (const hit of hits) {
      expect(hit.score).toBeGreaterThan(0);
      expect(hit.claim.id).toBeTruthy();
    }
  });
});
