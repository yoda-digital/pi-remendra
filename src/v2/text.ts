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

/**
 * Heuristic token estimate: UTF-16 code units / 4.
 * Matches Pi's own estimateTokens formula, giving consistent budget accounting
 * between the host context manager and Remendra's compiler. Accurate within ~25%
 * for ASCII, Cyrillic, CJK, and mixed scripts. Provider-reported usage is used
 * for actual billing when available; this estimate only gates dispatch and compilation.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
export const COUNTER = "chars/4-estimate";

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
    // OpenAI keys, GitHub tokens
    .replace(
      /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
      "[REDACTED]",
    )
    // AWS access keys (always start with AKIA)
    .replace(/\b(?:AKIA[A-Z0-9]{12,})\b/g, "[REDACTED]")
    // Stripe keys (secret, restricted, publishable — live and test)
    .replace(
      /\b(?:sk_(?:live|test)_[A-Za-z0-9]{20,}|rk_(?:live|test)_[A-Za-z0-9]{20,}|pk_(?:live|test)_[A-Za-z0-9]{20,})\b/g,
      "[REDACTED]",
    )
    // Slack tokens and app tokens
    .replace(/\b(?:xox[bpsa]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,})\b/g, "[REDACTED]")
    // Database connection URIs (postgres, mysql, mongodb, redis)
    .replace(
      /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|rediss):\/\/[^\s"',;}{)]+/gi,
      "[REDACTED_URI]",
    )
    // Auth headers, API keys, passwords, secrets, tokens
    .replace(
      /((?:authorization\s*[:=]\s*(?:bearer\s+)?|(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*)["']?)[^\s"',;}{]+/gi,
      "$1[REDACTED]",
    )
    // PEM private keys
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
