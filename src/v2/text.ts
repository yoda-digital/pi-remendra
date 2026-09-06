import { createHash } from "node:crypto";

export const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const normalize = (text: string): string =>
  text.normalize("NFC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim();
export const terms = (text: string): string[] =>
  [
    ...new Set(
      [
        ...normalize(text).matchAll(/[\p{L}\p{N}_]+/gu),
        ...normalize(text.replace(/([a-z])([A-Z])/g, "$1 $2")).matchAll(/[\p{L}\p{N}_]+/gu),
      ].map((match) => match[0]),
    ),
  ].slice(0, 32);

/** Conservative estimate, explicitly not a provider tokenizer. Full rendered packets are measured. */
export const estimateTokens = (text: string): number =>
  Math.ceil(Buffer.byteLength(text, "utf8") / 3);
export const COUNTER = "utf8-bytes/3-estimate";

export function clipTokens(text: string, budget: number): string {
  if (estimateTokens(text) <= budget) return text;
  if (budget < 2) return "";
  const suffix = "…";
  let lo = 0,
    hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTokens(text.slice(0, mid) + suffix) <= budget) lo = mid;
    else hi = mid - 1;
  }
  if (lo > 0 && /[\uD800-\uDBFF]/.test(text[lo - 1])) lo--;
  return text.slice(0, lo) + suffix;
}

export function redact(text: string, patterns: readonly string[] = []): string {
  let out = text
    .replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      "[REDACTED]",
    )
    .replace(
      /((?:authorization\s*[:=]\s*(?:bearer\s+)?|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)["']?)[^\s"',;}{]+/gi,
      "$1[REDACTED]",
    )
    .replace(
      /-----BEGIN (?:[A-Z ]+)?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+)?PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    );
  for (const literal of patterns) {
    // Configured patterns are literal secrets, avoiding untrusted regex execution.
    if (literal) out = out.split(literal).join("[REDACTED]");
  }
  return out
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

export function safeDate(value: string | undefined): boolean {
  return (
    value === undefined ||
    (Number.isFinite(Date.parse(value)) && /(?:Z|[+-]\d\d:\d\d)$/.test(value))
  );
}

/** Only exact normalized equality deduplicates; similarity produces retrieval candidates. */
export function equivalent(a: string, b: string): boolean {
  const left = normalize(a),
    right = normalize(b);
  return left.length > 0 && left === right;
}

export function jsonObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
