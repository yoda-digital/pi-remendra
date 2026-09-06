import type { MemoryStore } from "./store.js";
import type { Scope, ClaimInput } from "./types.js";
import { hash, jsonObject } from "./text.js";

/** Reads records directly: no legacy fold, fuzzy grouping, or relevance pruning. */
export function importLegacy(
  store: MemoryStore,
  scope: Scope,
  text: string,
): { imported: number; duplicates: number; skipped: number } {
  if (Buffer.byteLength(text) > 20 * 1024 * 1024)
    throw new Error("Legacy import exceeds 20 MiB; split it first");
  let values: unknown[];
  try {
    const value: unknown = JSON.parse(text);
    values = Array.isArray(value) ? value : [value];
  } catch {
    values = text
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  }
  const candidates: Array<{ value: Record<string, unknown>; type: string }> = [];
  let skipped = 0;
  const visit = (value: unknown, type = "observation", depth = 0): void => {
    if (depth > 8 || !jsonObject(value)) return;
    if (typeof value.content === "string" && typeof value.id === "string") {
      candidates.push({ value, type });
      return;
    }
    for (const key of ["observations", "reflections", "pending", "entries"] as const)
      if (Array.isArray(value[key]))
        for (const item of value[key])
          visit(item, key === "reflections" ? "reflection" : type, depth + 1);
    for (const key of ["data", "details", "memory"])
      if (jsonObject(value[key])) visit(value[key], type, depth + 1);
  };
  for (const value of values) visit(value);
  return store.transaction(() => {
    let imported = 0,
      duplicates = 0;
    for (const { value, type } of candidates) {
      const id = String(value.id),
        content = String(value.content);
      if (!content.trim() || content.length > 12000) {
        skipped++;
        continue;
      }
      const entryId = `legacy:${hash(JSON.stringify([id, content])).slice(0, 32)}`;
      const source = store.ingest(scope, [
        { entryId, role: "import", text: content, timestamp: "1970-01-01T00:00:00.000Z" },
      ]);
      const s = source.keys[0] ? store.source(source.keys[0]) : undefined;
      if (!s || s.erased) {
        skipped++;
        continue;
      }
      const input: ClaimInput = {
        id: `legacy:${hash(JSON.stringify([scope.projectId, scope.sessionId, id, content])).slice(0, 40)}`,
        alias: id,
        text: content,
        kind: type === "reflection" ? "hypothesis" : "fact",
        anchor: scope.entryIds.at(-1),
        evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: s.text.length }],
        rationale: `Imported v1 ${type}; original ID ${id}. Legacy source references: ${JSON.stringify(value.sourceEntryIds ?? value.supportingObservationIds ?? [])}`,
      };
      const result = store.record(
        { ...scope, entryIds: [...scope.entryIds, entryId] },
        input,
        "import",
      );
      if (result.duplicate) duplicates++;
      else imported++;
    }
    return { imported, duplicates, skipped };
  });
}
