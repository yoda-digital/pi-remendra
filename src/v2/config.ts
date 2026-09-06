import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryConfig } from "./types.js";
import { jsonObject } from "./text.js";

export const DEFAULT_CONFIG: MemoryConfig = {
  enabled: true,
  mode: "active",
  contextTokens: 2400,
  summaryTokens: 6000,
  outputReserve: 8000,
  includeUser: false,
  observer: true,
  observerInputTokens: 6000,
  observerOutputTokens: 1600,
  dailyTokenBudget: 80000,
  jobTimeoutMs: 45000,
  maxAttempts: 2,
  models: [],
  useSessionModel: true,
  excludedPaths: [".env", "credentials", "secrets"],
  redactionPatterns: [],
  recallTokens: 6000,
};

export function validateConfig(raw: unknown): MemoryConfig {
  if (!jsonObject(raw)) throw new Error("Memory configuration must be an object");
  const config = structuredClone(DEFAULT_CONFIG);
  const allowed = new Set([...Object.keys(DEFAULT_CONFIG), "embeddings"]);
  for (const key of Object.keys(raw))
    if (!allowed.has(key)) throw new Error(`Unknown memory setting: ${key}`);
  for (const key of ["enabled", "includeUser", "observer", "useSessionModel"] as const) {
    if (key in raw) {
      if (typeof raw[key] !== "boolean") throw new Error(`${key} must be boolean`);
      config[key] = raw[key];
    }
  }
  for (const key of [
    "contextTokens",
    "summaryTokens",
    "outputReserve",
    "observerInputTokens",
    "observerOutputTokens",
    "dailyTokenBudget",
    "jobTimeoutMs",
    "maxAttempts",
    "recallTokens",
  ] as const) {
    if (key in raw) {
      const value = raw[key];
      if (
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0 ||
        value > 10_000_000
      )
        throw new Error(`Invalid ${key}`);
      config[key] = value;
    }
  }
  if (
    config.contextTokens < 128 ||
    config.summaryTokens < 512 ||
    config.observerInputTokens < 2048 ||
    config.observerOutputTokens < 128 ||
    config.jobTimeoutMs < 1000 ||
    config.jobTimeoutMs > 120000 ||
    config.maxAttempts < 1 ||
    config.maxAttempts > 5
  )
    throw new Error("Memory limits are outside supported bounds");
  if (raw.mode !== undefined) {
    if (!["active", "shadow", "recall"].includes(String(raw.mode)))
      throw new Error("mode must be active, shadow, or recall");
    config.mode = raw.mode as MemoryConfig["mode"];
  }
  for (const key of ["excludedPaths", "redactionPatterns"] as const) {
    if (raw[key] !== undefined) {
      if (
        !Array.isArray(raw[key]) ||
        raw[key].length > 100 ||
        !raw[key].every((v) => typeof v === "string" && v.length <= 4096)
      )
        throw new Error(`Invalid ${key}`);
      config[key] = raw[key];
    }
  }
  if (raw.models !== undefined) {
    if (!Array.isArray(raw.models) || raw.models.length > 8)
      throw new Error("models must contain at most eight providers/models");
    config.models = raw.models.map((v) => {
      if (
        !jsonObject(v) ||
        typeof v.provider !== "string" ||
        typeof v.id !== "string" ||
        !v.provider ||
        !v.id
      )
        throw new Error("Each model needs provider and id");
      return { provider: v.provider, id: v.id };
    });
  }
  if (raw.embeddings !== undefined) {
    const e = raw.embeddings;
    if (!jsonObject(e) || typeof e.endpoint !== "string" || typeof e.model !== "string")
      throw new Error("embeddings needs endpoint and model");
    const url = new URL(e.endpoint);
    if (
      url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    )
      throw new Error("Embedding endpoint must use HTTPS or loopback HTTP");
    if (url.username || url.password || url.search || url.hash)
      throw new Error("Embedding credentials belong in an environment variable");
    if (
      e.apiKeyEnv !== undefined &&
      (typeof e.apiKeyEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/i.test(e.apiKeyEnv))
    )
      throw new Error("Invalid embedding API key environment variable");
    if (
      e.dimensions !== undefined &&
      (!Number.isInteger(e.dimensions) || Number(e.dimensions) < 1 || Number(e.dimensions) > 8192)
    )
      throw new Error("Invalid embedding dimensions");
    if (!e.model.trim() || e.model.length > 200) throw new Error("Invalid embedding model");
    config.embeddings = {
      endpoint: e.endpoint,
      model: e.model,
      apiKeyEnv: e.apiKeyEnv as string | undefined,
      dimensions: e.dimensions as number | undefined,
    };
  }
  return config;
}

export function loadConfig(directory: string): MemoryConfig {
  try {
    return validateConfig(JSON.parse(readFileSync(join(directory, "config.json"), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
    throw error;
  }
}

export function saveConfig(directory: string, raw: unknown): MemoryConfig {
  const config = validateConfig(raw);
  const file = join(directory, "config.json");
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
  return config;
}
