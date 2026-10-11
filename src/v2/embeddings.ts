import type { MemoryConfig } from "./types.js";
import { jsonObject } from "./text.js";

/**
 * Optional OpenAI-compatible /embeddings endpoint; no downloaded model or implicit credentials.
 * Embedding is rare and user-triggered, so the server usually has to load the model first:
 * a cold Ollama load measured 13 s, a warm batch of 32 under 2 s.
 */
export const EMBED_TIMEOUT_MS = 45000;

export class EmbeddingHttpError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Embedding endpoint returned HTTP ${status}`);
  }
  /**
   * Worth another try: overload, rate limits, and Ollama's runner dropping a request
   * (HTTP 400 "do embedding request: ... EOF"), which hit 30-50% of single calls while the
   * GPU was busy with a chat model.
   */
  get transient(): boolean {
    return (
      this.status >= 500 ||
      this.status === 429 ||
      (this.status === 400 && /\bEOF\b|do embedding request/i.test(this.detail))
    );
  }
}

/**
 * Prefixes a model was trained with. embeddinggemma's put the right memory first for 31 of
 * 36 paraphrased questions instead of 29 (35 of 36 together with observer cues).
 */
export function embeddingPrefixes(config: NonNullable<MemoryConfig["embeddings"]>): {
  query: string;
  document: string;
} {
  const known = /embeddinggemma/i.test(config.model)
    ? { query: "task: search result | query: ", document: "title: none | text: " }
    : /nomic-embed/i.test(config.model)
      ? { query: "search_query: ", document: "search_document: " }
      : /(^|[^a-z])e5([^a-z]|$)/i.test(config.model)
        ? { query: "query: ", document: "passage: " }
        : { query: "", document: "" };
  return {
    query: config.queryPrefix ?? known.query,
    document: config.documentPrefix ?? known.document,
  };
}

/** What is embedded for a memory: its text plus its search cues. */
export function memoryEmbeddingText(
  config: NonNullable<MemoryConfig["embeddings"]>,
  text: string,
  cues?: string[],
): string {
  return `${embeddingPrefixes(config).document}${text}${cues?.length ? ` (${cues.join(", ")})` : ""}`;
}

/**
 * fetchEmbeddings with recovery from transient server failures: a failing batch is retried,
 * then split in halves, so one dropped request cannot keep a whole batch from ever being
 * embedded. Stops at the deadline; permanent errors (auth, bad dimensions) are not retried.
 */
export async function fetchEmbeddingsResilient(
  config: NonNullable<MemoryConfig["embeddings"]>,
  input: string[],
  timeout = EMBED_TIMEOUT_MS,
  /** Called as each piece arrives, so a later failure or the deadline loses nothing done. */
  onVectors?: (offset: number, vectors: number[][], tokens?: number) => void,
): Promise<{ vectors: number[][]; tokens?: number }> {
  const deadline = Date.now() + timeout;
  const attempt = async (
    texts: string[],
    tries: number,
    offset: number,
  ): Promise<{ vectors: number[][]; tokens?: number }> => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("The operation was aborted due to timeout");
    try {
      const result = await fetchEmbeddings(config, texts, left);
      onVectors?.(offset, result.vectors, result.tokens);
      return result;
    } catch (error) {
      if (!(error instanceof EmbeddingHttpError) || !error.transient) throw error;
      if (texts.length > 1) {
        const half = Math.ceil(texts.length / 2);
        const a = await attempt(texts.slice(0, half), 2, offset);
        const b = await attempt(texts.slice(half), 2, offset + half);
        return {
          vectors: [...a.vectors, ...b.vectors],
          tokens:
            a.tokens === undefined || b.tokens === undefined ? undefined : a.tokens + b.tokens,
        };
      }
      if (tries <= 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
      return attempt(texts, tries - 1, offset);
    }
  };
  return attempt(input, 4, 0);
}
export async function fetchEmbeddings(
  config: NonNullable<MemoryConfig["embeddings"]>,
  input: string[],
  timeout = EMBED_TIMEOUT_MS,
): Promise<{ vectors: number[][]; tokens?: number }> {
  const key = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
  if (config.apiKeyEnv && !key)
    throw new Error(`Set ${config.apiKeyEnv} for the configured embedding endpoint`);
  const response = await fetch(config.endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      input,
      ...(config.dimensions ? { dimensions: config.dimensions } : {}),
    }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    throw new EmbeddingHttpError(response.status, detail);
  }
  if (!response.body) throw new Error("Embedding endpoint returned an empty body");
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 4 * 1024 * 1024) throw new Error("Embedding response exceeds 4 MiB");
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* Do not mask the original error */
    }
    reader.releaseLock();
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!jsonObject(parsed) || !Array.isArray(parsed.data) || parsed.data.length !== input.length)
    throw new Error("Embedding count does not match the input");
  const result = new Map<number, number[]>();
  let dimensions = config.dimensions;
  for (const row of parsed.data) {
    if (
      !jsonObject(row) ||
      !Number.isInteger(row.index) ||
      Number(row.index) < 0 ||
      Number(row.index) >= input.length ||
      result.has(Number(row.index)) ||
      !Array.isArray(row.embedding) ||
      !row.embedding.length ||
      row.embedding.length > 8192 ||
      !row.embedding.every((v) => typeof v === "number" && Number.isFinite(v))
    )
      throw new Error("Invalid embedding vector");
    dimensions ??= row.embedding.length;
    if (row.embedding.length !== dimensions) throw new Error("Embedding dimensions changed");
    result.set(Number(row.index), row.embedding);
  }
  const tokens =
    jsonObject(parsed.usage) &&
    typeof parsed.usage.total_tokens === "number" &&
    Number.isFinite(parsed.usage.total_tokens) &&
    parsed.usage.total_tokens >= 0
      ? parsed.usage.total_tokens
      : undefined;
  return { vectors: input.map((_, i) => result.get(i)!), tokens };
}
