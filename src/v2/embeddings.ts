import type { MemoryConfig } from "./types.js";
import { jsonObject } from "./text.js";

/** Optional OpenAI-compatible /embeddings endpoint; no downloaded model or implicit credentials. */
export async function fetchEmbeddings(
  config: NonNullable<MemoryConfig["embeddings"]>,
  input: string[],
  timeout = 10000,
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
    await response.body?.cancel();
    throw new Error(`Embedding endpoint returned HTTP ${response.status}`);
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
    await reader.cancel();
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
