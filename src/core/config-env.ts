/**
 * Declarative PI_REMENDRA_* environment overrides for the unified config.
 *
 * Single source of truth for the env-var surface, shared by:
 *  - ConfigManager (pi-base/config-manager.ts) — modal + om-off/om-on path
 *  - loadUnifiedConfig (core/unified-config.ts) — the runtime path
 *
 * This guarantees env overrides behave identically everywhere. (Previously
 * the runtime ignored the declarative map and only applied the passive
 * trio + compaction/compaction-engine vars.)
 */
import { readBooleanEnv, readPositiveIntEnv } from "../pi-base/config.js";

export interface EnvParser {
  /** Env var name */
  var: string;
  /** Custom parse function (receives raw string, returns parsed value) */
  parse: (raw: string, current: unknown) => unknown;
}

export type EnvOverride = string | EnvParser;

/**
 * Apply env overrides onto a config object. Field types are inferred from
 * the defaults (boolean → truthy parsing, positive integer → int parsing,
 * anything else → float). Returns a NEW object; input is not mutated.
 */
export function applyEnvOverrides<T extends object>(
  config: T,
  env: Record<string, EnvOverride>,
  defaults: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = {
    ...(config as Record<string, unknown>),
  };

  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;

    const defaultValue = defaults[key];

    if (typeof value === "string") {
      if (typeof defaultValue === "boolean") {
        result[key] = readBooleanEnv(value, (result[key] as boolean) ?? (defaultValue as boolean));
      } else if (typeof defaultValue === "number") {
        if (Number.isInteger(defaultValue) && defaultValue > 0) {
          result[key] = readPositiveIntEnv(
            value,
            (result[key] as number) ?? (defaultValue as number),
          );
        } else {
          // Float — parse and preserve
          const raw = process.env[value]?.trim();
          if (raw) {
            const parsed = Number.parseFloat(raw);
            if (Number.isFinite(parsed)) {
              result[key] = parsed;
            }
          }
        }
      }
    } else {
      const raw = process.env[value.var]?.trim();
      if (raw) {
        const parsed = value.parse(raw, result[key]);
        if (parsed !== undefined) {
          result[key] = parsed;
        }
      }
    }
  }

  return result as T;
}

/**
 * The declarative PI_REMENDRA_* env-var map. Keys are UnifiedConfig field
 * names; values are the env var names (or parsers for special types).
 */
export const DECLARATIVE_ENV_OVERRIDES: Record<string, EnvOverride> = {
  // Booleans
  memory: "PI_REMENDRA_MEMORY",
  debug: "PI_REMENDRA_DEBUG",
  debugLog: "PI_REMENDRA_DEBUG_LOG",
  sessionFallback: "PI_REMENDRA_SESSION_FALLBACK",
  fullFoldAlways: "PI_REMENDRA_FULL_FOLD_ALWAYS",
  // Positive integers
  compactAfterTokens: "PI_REMENDRA_COMPACT_AFTER_TOKENS",
  observeAfterTokens: "PI_REMENDRA_OBSERVE_AFTER_TOKENS",
  reflectAfterTokens: "PI_REMENDRA_REFLECT_AFTER_TOKENS",
  observationsPoolMaxTokens: "PI_REMENDRA_OBSERVATIONS_POOL_MAX_TOKENS",
  observationsPoolTargetTokens: "PI_REMENDRA_OBSERVATIONS_POOL_TARGET_TOKENS",
  reflectorInputMaxTokens: "PI_REMENDRA_REFLECTOR_INPUT_MAX_TOKENS",
  dropperInputMaxTokens: "PI_REMENDRA_DROPPER_INPUT_MAX_TOKENS",
  observerChunkMaxTokens: "PI_REMENDRA_OBSERVER_CHUNK_MAX_TOKENS",
  observerPreambleMaxTokens: "PI_REMENDRA_OBSERVER_PREAMBLE_MAX_TOKENS",
  agentMaxTurns: "PI_REMENDRA_AGENT_MAX_TURNS",
  // Non-negative integer (0 = disabled, unset = inherit pi default)
  providerIdleTimeoutMs: {
    var: "PI_REMENDRA_PROVIDER_IDLE_TIMEOUT_MS",
    parse: (raw: string) => {
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 ? n : undefined;
    },
  },
  // Float in (0, 1]
  dropperPressureThreshold: {
    var: "PI_REMENDRA_DROPPER_PRESSURE_THRESHOLD",
    parse: (raw: string) => {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n > 0 && n <= 1 ? n : undefined;
    },
  },
  // Float in (0, 1]
  dropperPoolFullnessThreshold: {
    var: "PI_REMENDRA_DROPPER_POOL_FULLNESS_THRESHOLD",
    parse: (raw: string) => {
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n > 0 && n <= 1 ? n : undefined;
    },
  },
  // Comma-separated provider skip list ("provider" or "provider:api")
  skipForProviders: {
    var: "PI_REMENDRA_SKIP_PROVIDERS",
    parse: (raw: string) =>
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
  },
  // Enum overrides — custom parsers because canonical only auto-handles
  // booleans and positive integers.
  compaction: {
    var: "PI_REMENDRA_COMPACTION",
    parse: (raw: string) => {
      const trimmed = raw.trim().toLowerCase();
      return ["auto", "manual", "off"].includes(trimmed)
        ? (trimmed as "auto" | "manual" | "off")
        : undefined;
    },
  },
  compactionEngine: {
    var: "PI_REMENDRA_COMPACTION_ENGINE",
    parse: (raw: string) => {
      const trimmed = raw.trim().toLowerCase();
      return ["remendra", "pi-default"].includes(trimmed)
        ? (trimmed as "remendra" | "pi-default")
        : undefined;
    },
  },
  compactionSummaryMode: {
    var: "PI_REMENDRA_COMPACTION_SUMMARY_MODE",
    parse: (raw: string) => {
      const trimmed = raw.trim().toLowerCase();
      return ["default", "append"].includes(trimmed)
        ? (trimmed as "default" | "append")
        : undefined;
    },
  },
  midRunCompaction: {
    var: "PI_REMENDRA_MID_RUN_COMPACTION",
    parse: (raw: string) => {
      const trimmed = raw.trim().toLowerCase();
      return ["resume", "pause", "off"].includes(trimmed)
        ? (trimmed as "resume" | "pause" | "off")
        : undefined;
    },
  },
};
