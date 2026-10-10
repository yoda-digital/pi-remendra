import type { RecallRequest } from "./recall.js";

const MODES = ["memory", "history", "source", "regex", "file", "touched"] as const;

// Values models actually sent in real sessions, mapped to what they meant.
const MODE_SYNONYMS: Record<string, RecallRequest["mode"]> = {
  claims: "memory",
  claim: "memory",
  memories: "memory",
  facts: "memory",
  search: "memory",
  all: "memory",
  transcript: "source",
  messages: "source",
  sessions: "source",
  files: "file",
};
const SCOPE_SYNONYMS: Record<string, RecallRequest["scope"]> = {
  lineage: "lineage",
  current: "lineage",
  session: "lineage",
  branch: "lineage",
  all: "all",
  project: "all",
  global: "all",
  user: "all",
  everything: "all",
};

/**
 * Small models fill enum fields with near-miss words ("claims", "project"). Pi validates
 * the arguments after this hook, so a near miss would otherwise fail the whole call and
 * the model usually gives up on memory. Map known synonyms, drop unknown values so the
 * defaults apply, and coerce numeric strings.
 */
export function normalizeRecallArgs(raw: unknown): RecallRequest {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const args = { ...(raw as Record<string, unknown>) };
  const word = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : undefined);
  if (args.mode !== undefined) {
    const mode = word(args.mode);
    if (mode === "all" && args.scope === undefined) args.scope = "all";
    args.mode = (MODES as readonly string[]).includes(mode ?? "")
      ? mode
      : mode
        ? MODE_SYNONYMS[mode]
        : undefined;
    if (args.mode === undefined) delete args.mode;
  }
  if (args.scope !== undefined) {
    const scope = word(args.scope);
    args.scope = scope ? SCOPE_SYNONYMS[scope] : undefined;
    if (args.scope === undefined) delete args.scope;
  }
  if (typeof args.page === "string" && /^\d+$/.test(args.page.trim()))
    args.page = Number(args.page);
  if (typeof args.expand === "number") args.expand = [args.expand];
  if (typeof args.expand === "string")
    args.expand = args.expand
      .split(/[\s,]+/)
      .filter((v) => /^\d+$/.test(v))
      .map(Number);
  if (args.query !== undefined && typeof args.query !== "string") delete args.query;
  return args as RecallRequest;
}
