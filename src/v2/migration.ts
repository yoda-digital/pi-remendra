import type { MemoryStore } from "./store.js";
import type { Scope, ClaimInput } from "./types.js";
import { hash, jsonObject } from "./text.js";

/** Reads records directly: no legacy fold, fuzzy grouping, or relevance pruning. */
export function importLegacy(
  store: MemoryStore,
  scope: Scope,
  text: string,
): { imported: number; duplicates: number; skipped: number; partialFailures: number } {
  if (Buffer.byteLength(text) > 20 * 1024 * 1024)
    throw new Error("Legacy import exceeds 20 MiB; split it first");
  let values: unknown[];
  try {
    const value: unknown = JSON.parse(text);
    values = Array.isArray(value) ? value : [value];
  } catch (jsonError) {
    try {
      values = text
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as unknown);
    } catch (jsonlError) {
      throw new Error(
        `Input is neither valid JSON (${jsonError instanceof Error ? jsonError.message : String(jsonError)}) nor JSONL (${jsonlError instanceof Error ? jsonlError.message : String(jsonlError)})`,
      );
    }
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
      duplicates = 0,
      partialFailures = 0;
    for (const { value, type } of candidates) {
      const id = String(value.id),
        content = String(value.content);
      if (!content.trim() || content.length > 12000) {
        if (content.length > 12000) {
          console.warn(
            "[remendra] Migration skipped oversized record (" +
              content.length +
              " chars): " +
              id.slice(0, 20),
          );
        }
        skipped++;
        continue;
      }
      const entryId = `legacy:${hash(JSON.stringify([id, content])).slice(0, 32)}`;
      let timestamp = new Date().toISOString();
      if (typeof value.timestamp === "string" && value.timestamp) timestamp = value.timestamp;
      else if (typeof value.createdAt === "string" && value.createdAt) timestamp = value.createdAt;
      const source = store.ingest(scope, [{ entryId, role: "import", text: content, timestamp }]);
      const s = source.keys[0] ? store.source(source.keys[0]) : undefined;
      if (!s || s.erased) {
        skipped++;
        continue;
      }
      const relevance = typeof value.relevance === "string" ? value.relevance : undefined;
      const input: ClaimInput = {
        id: `legacy:${hash(JSON.stringify([scope.projectId, scope.sessionId, id, content])).slice(0, 40)}`,
        alias: id,
        text: content,
        kind: "fact",
        anchor: scope.entryIds.at(-1),
        evidence: [{ sourceKey: s.key, hash: s.hash, start: 0, end: s.text.length }],
        rationale: `Imported v1 ${type}; original ID ${id}. Legacy source references: ${JSON.stringify(value.sourceEntryIds ?? value.supportingObservationIds ?? [])}`,
      };
      const result = store.record(
        { ...scope, entryIds: [...scope.entryIds, entryId] },
        input,
        "import",
      );
      if (!result.duplicate && result.claim.status === "candidate") {
        try {
          const accepted = store.change(
            { ...scope, entryIds: [...scope.entryIds, entryId] },
            result.claim.id,
            result.claim.revision,
            "accept",
          );
          if (relevance === "critical" || relevance === "high") {
            store.change(
              { ...scope, entryIds: [...scope.entryIds, entryId] },
              accepted.id,
              accepted.revision,
              "pin",
            );
          }
        } catch (statusError) {
          partialFailures++;
          console.error(
            "[remendra] migration status change failed for",
            result.claim.id,
            ":",
            statusError instanceof Error ? statusError.message : String(statusError),
          );
        }
      }
      if (result.duplicate) duplicates++;
      else imported++;
    }
    return { imported, duplicates, skipped, partialFailures };
  });
}
