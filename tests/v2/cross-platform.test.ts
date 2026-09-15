import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { MemoryStore } from "../../src/v2/store.js";
import type { Scope, Source } from "../../src/v2/types.js";

const dirs: string[] = [];
function tempDir(name: string): string {
  const dir = join(tmpdir(), `remendra-test-${name}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of dirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* Windows may hold file locks briefly */
    }
  }
  dirs.length = 0;
});

describe("cross-platform paths", () => {
  it("creates database in path with spaces", () => {
    const dir = tempDir("with spaces");
    const store = new MemoryStore(join(dir, "v2", "memory.sqlite"));
    expect(store.doctor().foreignKeys).toEqual([]);
    store.close();
  });

  it("creates database in path with unicode characters", () => {
    const dir = tempDir("ремендра-тест");
    const store = new MemoryStore(join(dir, "v2", "memory.sqlite"));
    expect(store.doctor().foreignKeys).toEqual([]);
    store.close();
  });

  it("creates database in path with CJK characters", () => {
    const dir = tempDir("测试目录");
    const store = new MemoryStore(join(dir, "v2", "memory.sqlite"));
    expect(store.doctor().foreignKeys).toEqual([]);
    store.close();
  });

  it("handles long path segments", () => {
    const longName = "a".repeat(100);
    const dir = tempDir(longName);
    const store = new MemoryStore(join(dir, "memory.sqlite"));
    expect(store.doctor().foreignKeys).toEqual([]);
    store.close();
  });
});

function setupStore(): { store: MemoryStore; scope: Scope; source: () => Source } {
  const store = new MemoryStore(":memory:");
  const scope: Scope = {
    projectId: store.project("/test/xplat"),
    sessionId: "s1",
    entryIds: [],
  };
  const makeSource = (text = "source"): Source => {
    const id = `e-${scope.entryIds.length}`;
    scope.entryIds.push(id);
    const result = store.ingest(scope, [
      { entryId: id, text, role: "user", timestamp: new Date().toISOString() },
    ]);
    return store.source(result.keys[0])!;
  };
  return { store, scope, source: makeSource };
}

describe("cross-platform data integrity", () => {
  it("stores and retrieves Cyrillic claim text", () => {
    const { store, scope, source } = setupStore();
    const s = source("Привет мир на русском");
    const result = store.record(
      scope,
      {
        text: "Используй PostgreSQL для хранения данных",
        kind: "constraint",
        evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: s.text.length }],
      },
      "user",
    );
    const hits = store.search({ scope, text: "PostgreSQL" });
    expect(hits.some((h) => h.claim.id === result.claim.id)).toBe(true);
    store.close();
  });

  it("stores and retrieves CJK claim text", () => {
    const { store, scope, source } = setupStore();
    const s = source("你好世界测试中文文本内容");
    const result = store.record(
      scope,
      {
        text: "使用数据库进行存储和检索操作",
        kind: "fact",
        evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: s.text.length }],
      },
      "user",
    );
    // CJK is stored correctly even though FTS5 unicode61 tokenizer
    // has limited CJK word segmentation. Verify storage integrity.
    expect(result.claim.text).toBe("使用数据库进行存储和检索操作");
    // Search by ID always works regardless of tokenizer
    const claim = store.claim(result.claim.id, scope);
    expect(claim).toBeTruthy();
    expect(claim!.text).toBe("使用数据库进行存储和检索操作");
    store.close();
  });

  it("stores and retrieves emoji in claim text", () => {
    const { store, scope, source } = setupStore();
    const s = source("test content with emoji 🎉 for validation");
    const result = store.record(
      scope,
      {
        text: "Deploy celebrations 🎉 should not happen on Friday",
        kind: "constraint",
        evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: s.text.length }],
      },
      "user",
    );
    expect(result.claim.text).toContain("🎉");
    store.close();
  });
});
