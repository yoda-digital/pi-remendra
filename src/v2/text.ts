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

/** Words too common to search for (English). */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "and",
  "or",
  "but",
  "if",
  "we",
  "our",
  "you",
  "your",
  "they",
  "them",
  "me",
  "my",
  // English
  "the",
  "a",
  "an",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "of",
  "in",
  "to",
  "for",
  "with",
  "on",
  "at",
  "from",
  "by",
  "as",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "between",
  "out",
  "off",
  "over",
  "under",
  "again",
  "further",
  "then",
  "once",
  "here",
  "there",
  "when",
  "where",
  "why",
  "how",
  "all",
  "both",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "about",
  "it",
  "its",
  "that",
  "this",
  "what",
  "which",
  "who",
  "whom",
  "these",
  "those",
]);

const quoteFts = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * FTS5 MATCH expression for a free-text query on the trigram index: any of the
 * query's meaningful terms (3+ characters, not stop words), so "where do we deploy
 * the api" finds claims about deploying or the API instead of requiring that exact
 * sentence. bm25 ranks claims matching more terms higher. Falls back to the whole
 * query as one phrase when no term qualifies (short CJK words, all stop words).
 * Returns undefined when nothing is searchable (under 3 characters in total).
 */
export function ftsMatch(text: string): string | undefined {
  const query = text.trim();
  const words = terms(query).filter((w) => [...w].length >= 3 && !STOPWORDS.has(w));
  if (words.length) return words.slice(0, 16).map(quoteFts).join(" OR ");
  return [...query].length >= 3 ? quoteFts(query) : undefined;
}

/** Terms used to filter results in JS where SQL full-text search cannot (history, short queries). */
export function textFilterTerms(text: string): string[] {
  return terms(text.trim()).filter((w) => !STOPWORDS.has(w));
}
