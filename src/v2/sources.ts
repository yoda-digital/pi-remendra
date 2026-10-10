import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SourceInput } from "./types.js";
import { jsonObject } from "./text.js";

/** No chain-of-thought, binary attachments, or extension context is copied into memory. */
export function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((block: unknown) => {
      if (!jsonObject(block)) return [];
      if (block.type === "text" && typeof block.text === "string") return [block.text];
      if (block.type === "toolCall")
        return [`Tool call ${String(block.name ?? "")}: ${JSON.stringify(block.arguments ?? {})}`];
      if (block.type === "image") return ["[image omitted; inspect the original session]"];
      return [];
    })
    .join("\n");
}

/** Top-level string arguments of a tool call, including strings inside arrays. */
function argumentStrings(args: Record<string, unknown> | undefined): string[] {
  return Object.values(args ?? {}).flatMap((v) =>
    typeof v === "string"
      ? [v]
      : Array.isArray(v)
        ? v.filter((x): x is string => typeof x === "string")
        : [],
  );
}

/** Replacement content of an edited entry, or null when the edit removes it from context. */
export type ContextEdit = { content: unknown } | null;

/**
 * The latest Pi context edit per target entry on this branch. A user who removes or
 * rewrites a message for future context does not want memory to keep learning from the
 * original either.
 */
export function contextEdits(entries: readonly SessionEntry[]): Map<string, ContextEdit> {
  const edits = new Map<string, ContextEdit>();
  for (const entry of entries) {
    const e = entry as { type: string; targetId?: unknown; replacement?: unknown };
    if (e.type !== "context_edit" || typeof e.targetId !== "string") continue;
    const r = e.replacement as { content?: unknown } | null | undefined;
    edits.set(e.targetId, r && typeof r === "object" ? { content: r.content } : null);
  }
  return edits;
}

export function sourceInputs(
  entries: readonly SessionEntry[],
  excludedPaths: readonly string[] = [],
  edits: ReadonlyMap<string, ContextEdit> = new Map(),
): SourceInput[] {
  const inputs: SourceInput[] = [];
  const calls = new Map<string, { name: string; target?: string }>();
  let episodeId: string | undefined;
  for (const entry of entries) {
    if (entry.type === "branch_summary") {
      inputs.push({
        entryId: entry.id,
        parentId: entry.parentId,
        role: "branch_summary",
        text: entry.summary,
        timestamp: entry.timestamp,
        episodeId,
      });
      continue;
    }
    if (entry.type !== "message") continue;
    const m = entry.message;
    if (m.role !== "user" && m.role !== "assistant" && m.role !== "toolResult") continue;
    if (m.role === "user") episodeId = entry.id;
    if (m.role === "assistant")
      for (const block of m.content) {
        if (block.type !== "toolCall") continue;
        const args = block.arguments;
        const pathTarget =
          typeof args.path === "string"
            ? args.path
            : typeof args.file_path === "string"
              ? args.file_path
              : undefined;
        // Any argument can name a sensitive file (`bash` running `cat .env`, a grep pattern):
        // when one does, it becomes the target, so the call and its output are both excluded.
        const sensitive = argumentStrings(args).find((v) =>
          excludedPaths.some((p) => v.includes(p)),
        );
        calls.set(block.id, { name: block.name, target: sensitive ?? pathTarget });
      }
    const call = m.role === "toolResult" ? calls.get(m.toolCallId) : undefined;
    const edit = edits.get(entry.id);
    const content =
      edit === null
        ? "" // removed from context: an empty source retracts what was learned from it
        : edit
          ? edit.content
          : m.role === "assistant"
            ? m.content.map((block) => {
                if (block.type !== "toolCall") return block;
                const target = calls.get(block.id)?.target;
                return target && excludedPaths.some((path) => target.includes(path))
                  ? { type: "text", text: `Tool call ${block.name}: [sensitive path excluded]` }
                  : block;
              })
            : m.content;
    inputs.push({
      entryId: entry.id,
      parentId: entry.parentId,
      role: m.role,
      text: messageText(content),
      timestamp: entry.timestamp,
      tool: m.role === "toolResult" ? m.toolName : undefined,
      target: call?.target,
      isError: m.role === "toolResult" ? m.isError : undefined,
      episodeId,
    });
  }
  return inputs;
}

// L18: sourceFingerprint was dead code (exported but never imported).
// The store's ingest() computes its own digest inline with a different formula
// (includes role, uses redacted text). Removed to avoid confusion.
