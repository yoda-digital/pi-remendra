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

export function sourceInputs(
  entries: readonly SessionEntry[],
  excludedPaths: readonly string[] = [],
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
        const target =
          typeof args.path === "string"
            ? args.path
            : typeof args.file_path === "string"
              ? args.file_path
              : undefined;
        calls.set(block.id, { name: block.name, target });
      }
    const call = m.role === "toolResult" ? calls.get(m.toolCallId) : undefined;
    const content =
      m.role === "assistant"
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

/** Hash only source-bearing data; metadata edits do not trigger a full re-ingestion. */
export function sourceFingerprint(source: SourceInput): string {
  return JSON.stringify([
    source.text,
    source.timestamp,
    source.tool,
    source.target,
    source.isError,
  ]);
}
