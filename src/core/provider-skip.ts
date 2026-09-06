/**
 * EXPERIMENTAL COMPATIBILITY SHIM — pi-codex-compaction coexistence.
 *
 * Not part of blackhole's supported config surface. The mechanism exists so a
 * user running pi-codex-compaction (OpenAI Codex native remote compaction,
 * preserving opaque checkpoints) can list a provider in `skipForProviders` and
 * have blackhole step aside entirely for it — no compaction, no
 * observational-memory consolidation — so exactly one compaction engine acts
 * per turn, regardless of extension registration order.
 *
 * Maintenance policy:
 * - Do not extend, polish, or document this surface without a SECOND consumer.
 *   The only known user is the pi-codex-compaction / beautiful-pi combo.
 * - Correctness rests on an EXTERNAL, locally unverifiable assumption: that
 *   pi-codex-compaction's `session_before_compact` handler returns a
 *   `{ compaction }` result for supported Codex models and `undefined`
 *   otherwise. If that package changes, this shim silently no-ops (safe, but
 *   coordination is lost).
 * - `skipForProviders` intentionally couples two behaviors (no compaction AND
 *   no OM consolidation). A future compactor may need only one — split the key
 *   then; do not pre-split now.
 * - Deliberately absent from README/CONFIG.md/settings/env-var docs; surfaced
 *   only in example-config.json and the CHANGELOG entry for this PR.
 */

type ProviderModel = { provider: string; api?: string };

function isProviderModel(model: unknown): model is ProviderModel {
  if (model === null || typeof model !== "object" || !("provider" in model)) {
    return false;
  }

  const { provider } = model;
  return typeof provider === "string" && provider.length > 0;
}

export function getModelProvider(model: unknown): string | undefined {
  return isProviderModel(model) ? model.provider : undefined;
}

/** True when the active model's provider (or provider:api) is in skipForProviders. */
export function matchesSkippedProvider(
  config: { skipForProviders?: string[] },
  model: unknown,
): boolean {
  const list = config.skipForProviders;
  if (!list || list.length === 0 || !isProviderModel(model)) return false;

  for (const entry of list) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const [entryProvider, entryApi] = trimmed.split(":", 2);
    if (entryProvider !== model.provider) continue;
    // Bare provider entry skips any api. "provider:" targets models with no
    // api, while "provider:api" matches that exact api.
    if (
      entryApi === undefined ||
      (entryApi === "" ? model.api === undefined : entryApi === model.api)
    ) {
      return true;
    }
  }
  return false;
}
