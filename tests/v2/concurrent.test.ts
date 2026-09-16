import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { MemoryStore } from "../../src/v2/store.js";
import type { Scope } from "../../src/v2/types.js";

const dirs: string[] = [];
function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "remendra-concurrent-"));
  dirs.push(dir);
  return join(dir, "memory.sqlite");
}

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* may be locked briefly */
    }
  }
  dirs.length = 0;
});

function ingestAndRecord(store: MemoryStore, scope: Scope, text: string, i: number) {
  const id = `e-${i}`;
  scope.entryIds.push(id);
  const result = store.ingest(scope, [
    { entryId: id, text: `${text} source ${i}`, role: "user", timestamp: new Date().toISOString() },
  ]);
  const s = store.source(result.keys[0])!;
  store.record(
    scope,
    {
      text: `${text} claim ${i} about testing`,
      kind: "fact",
      evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: s.text.length }],
    },
    "observer",
  );
}

describe("concurrent access", () => {
  it("two stores interleave writes without corruption", () => {
    const dbPath = tempDb();
    const store1 = new MemoryStore(dbPath);
    const store2 = new MemoryStore(dbPath);
    const scope1: Scope = {
      projectId: store1.project("/test/c1"),
      sessionId: "s1",
      entryIds: [],
    };
    const scope2: Scope = {
      projectId: store2.project("/test/c2"),
      sessionId: "s2",
      entryIds: [],
    };

    for (let i = 0; i < 20; i++) {
      ingestAndRecord(store1, scope1, "Writer1", i);
      ingestAndRecord(store2, scope2, "Writer2", i);
    }

    expect(store1.doctor().foreignKeys).toEqual([]);
    expect(store2.doctor().foreignKeys).toEqual([]);

    store1.close();
    store2.close();

    const verify = new MemoryStore(dbPath);
    expect(verify.doctor().foreignKeys).toEqual([]);
    verify.close();
  });

  it("reader sees consistent snapshot during writes", () => {
    const dbPath = tempDb();
    const writer = new MemoryStore(dbPath);
    const reader = new MemoryStore(dbPath);
    const scope: Scope = {
      projectId: writer.project("/test/snap"),
      sessionId: "s1",
      entryIds: [],
    };

    for (let i = 0; i < 50; i++) {
      ingestAndRecord(writer, scope, "Snapshot", i);

      // Reader searches mid-write
      const hits = reader.search({ scope, text: "Snapshot", limit: 100 });
      for (const hit of hits) {
        expect(hit.claim.id).toBeTruthy();
        expect(hit.claim.text).toBeTruthy();
        expect(hit.claim.status).toBeTruthy();
      }
    }

    writer.close();
    reader.close();
  });

  it("handles rapid open-write-close cycles", () => {
    const dbPath = tempDb();

    for (let i = 0; i < 10; i++) {
      const store = new MemoryStore(dbPath);
      const scope: Scope = {
        projectId: store.project("/test/rapid"),
        sessionId: `s${i}`,
        entryIds: [],
      };
      ingestAndRecord(store, scope, "Rapid", i);
      expect(store.doctor().foreignKeys).toEqual([]);
      store.close();
    }

    const final = new MemoryStore(dbPath);
    expect(final.doctor().foreignKeys).toEqual([]);
    final.close();
  });
});
