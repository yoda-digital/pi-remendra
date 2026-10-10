import { isAbsolute, relative } from "node:path";
import type { SourceInput } from "./types.js";

/**
 * Parsing Pi session files (JSONL) for /remendra index-sessions.
 *
 * Line 1 is the header {"type":"session","id","cwd",...}. Conversation lines are
 * {"type":"message","id","timestamp","message":{role,content}}; system, custom and
 * other entries are not conversation and are skipped.
 */

export interface ParsedSession {
  id?: string;
  cwd?: string;
  sources: SourceInput[];
}

const MIN_TEXT = 10;
const MAX_TEXT = 50_000;

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (b): b is { type: string; text: string } =>
        !!b && typeof b === "object" && b.type === "text" && typeof b.text === "string",
    )
    .map((b) => b.text)
    .join("\n");
}

export function parseSessionFile(content: string): ParsedSession {
  const session: ParsedSession = { sources: [] };
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let rec: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object") continue;
      rec = parsed as Record<string, unknown>;
    } catch {
      continue; // a partial last line while Pi is still writing, or corruption
    }
    if (rec.type === "session") {
      if (typeof rec.id === "string") session.id = rec.id;
      if (typeof rec.cwd === "string") session.cwd = rec.cwd;
      continue;
    }
    if (rec.type !== "message" || typeof rec.id !== "string") continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    const role = msg?.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
    const text = textOf(msg?.content).trim();
    if (text.length < MIN_TEXT) continue;
    session.sources.push({
      entryId: rec.id,
      role,
      text: text.slice(0, MAX_TEXT),
      timestamp: typeof rec.timestamp === "string" ? rec.timestamp : new Date().toISOString(),
      ...(role === "toolResult" && typeof msg?.toolName === "string" ? { tool: msg.toolName } : {}),
    });
  }
  return session;
}

/** Whether a session started in `cwd` belongs to the project at `projectPath` (same folder or inside it). */
export function sessionInProject(
  cwd: string | undefined,
  projectPath: string | undefined,
): boolean {
  if (!projectPath) return true;
  if (!cwd) return false;
  const rel = relative(projectPath, cwd);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
