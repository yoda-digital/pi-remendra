# AGENTS.md

## Remendra v2 default engine

The default entry exports `src/v2/extension.ts`; the package loads `dist/index.js`. Remendra's public identifiers are `/remendra`, `remendra-memory`, `PI_REMENDRA_*`, and `~/.pi/agent/pi-remendra/v2/`. V2 uses public Pi 0.85.1 hooks, the native model registry, and a SQLite worker. Its defaults are in `src/v2/config.ts`; its contracts are in `src/v2/types.ts`. Run `pnpm test:v2` for focused coverage and `pnpm test:smoke` for the real Pi SDK smoke test after building. Node 24 is the validated runtime.

`dist/` is committed because Pi installs Git packages with production dependencies only; rebuild and commit it after source changes. `legacy.ts` preserves the original Blackhole entry for explicit rollback. The architecture and configuration descriptions below refer to that legacy engine unless they name `src/v2`. Shared workflow and testing rules still apply. V2 documentation lives in README.md and docs/V2.md.

Pi extension package: algorithmic compaction (pi-vcc) + observational memory (pi-observational-memory), merged and heavily diverged. See README.md (features), docs/CONFIG.md (config reference), docs/ (architecture, vcc, om, recall, append-compaction, CHANGELOG).

## Commands

```bash
pnpm test          # vitest run (all tests, 97 files, no network)
pnpm typecheck     # tsc --noEmit (src/**/*.ts + index.ts only)
pnpm lint          # eslint .
pnpm format:check  # prettier --check .
pnpm build         # tsup bundle → committed dist/ (required for Git installs)
pnpm check         # typecheck + lint
```

- CI order: `build` → `typecheck` → `lint` → `test` → `format:check` (.github/workflows/ci.yml).
- pre-commit: lint-staged (now in `package.json:lint-staged`) + typecheck. pre-push: typecheck + test (skipped for docs-only pushes).
- pnpm only (`packageManager: pnpm@11.2.2`). TypeScript pinned to 6.0.3 for @typescript-eslint v8 compat — never bump TS alone.
- `prettier` config and `lint-staged` live in `package.json` (no separate `.prettierrc.json` / `.lintstagedrc.json`); `.prettierignore` stays at root.
- Prepare script (`scripts/prepare.mjs`) builds dist via tsup on install; must never break consumer installs.

## Testing quirks

- Source imports use `.js` extensions (`../om/tokens.js`); vitest's alias strips them. Keep this convention in new files.
- **`tests/` is NOT in tsconfig.json** — running tsc over tests surfaces ~150 pre-existing type errors tracked as a separate cleanup. Do not "fix" test type errors; eslint lints tests without type-aware rules.
- `src/pi-base/**/*.test.ts` is excluded from tsconfig and type-aware lint by design.
- Tests are pure unit tests with fake agent loops — no LLM/network. `tests/vcc-support/real-sessions.ts` optionally samples `~/.pi/agent/sessions`, but nothing requires real data.

## Legacy v1 architecture (`dist/legacy.js`)

- `legacy.ts` is the original extension entry: it installs the host inline-compaction adapter, captures provider streams, and registers the legacy commands and hooks. It is built for rollback but is not registered by the package manifest.
- `src/core/` — unified config (`unified-config.ts` = defaults + resolution; env overrides declared in `config-env.ts` as `PI_BLACKHOLE_*`). configManager is the true source and entry point - users edit in UI.
- `src/extract/` — vcc compaction section extraction (goals, files, commits, preferences, brief).
- `src/om/` — observational memory: `agents/` (observer → reflector → dropper agent loops), `ledger/`, `runtime.ts`, `consolidation.ts`, `compaction-trigger.ts`, `cooldown.ts` (persisted fallback cooldowns), `pending.ts` (manual-mode disk buffers), `inline-compaction.ts`.
- `src/project-recall/` — project-scoped memory: `corpus.ts` (project session scan + pending orphan attribution), `dedup.ts`, `format-export.ts`, `session-dir.ts`.
- `src/hooks/` — `before-compact.ts` (`session_before_compact`), `compact-failed.ts` (`session_compact_failed` pi >=0.84.3), `compaction-context.ts` (`context` append-mode projection).
- `src/commands/` — `pi-vcc.ts` (`/blackhole`), `memory.ts` (`/blackhole-memory`), `vcc-recall.ts` (`/blackhole-recall`), `blackhole-export.ts` (`/blackhole-export`), `cleanup.ts`.
- `src/tools/recall.ts` — session-history search/expand/drill-down.
- `src/pi-base/` — **vendored copy of pi's internal core** (config manager + settings modal). Treat as upstream code: copy verbatim, surgical rewiring only, never rewrite from memory. Changes here also apply to the pi-utils monorepo context.
- `docs/` — committed product docs: `architecture.md`, `observational-memory.md`, `recall.md`, `vcc-compaction.md`, `APPEND_COMPACTION.md`. `docs/archived_docs/` is local-only (gitignored) — working notes, bughunts, handovers.
- `work_docs/` — separate planning - committed and tracked directory.


## Workflow conventions

- `main` is the installable Git release branch. Every source change that affects runtime behavior must include a rebuilt `dist/` so `pi install git:github.com/yoda-digital/pi-remendra` remains self-contained.
- Conventional commits (`feat:`, `fix:`, `chore(release):`, `build(deps-dev):` with scopes like `(pi-base)`, `(recall)`, `(export)`).
- docs/CHANGELOG.md is hand-maintained (keepachangelog style with a Dependencies section). `## [Unreleased]` on `dev` becomes `## [X.Y.Z] - YYYY-MM-DD` on release.
- Docs consistency: every number in README.md / docs/CONFIG.md / llms.txt must match `src/core/unified-config.ts` defaults — cross-check when changing defaults. `docs/` mirrors the same source of truth.

## Debugging / runtime

- Runtime clone for local testing: `~/.pi/agent/git/github.com/k0valik/pi-blackhole/` — sync changes there and `/reload` Pi.
- `debug: true` → pre-compaction snapshot at `/tmp/pi-blackhole-debug.json`; `debugLog: true` → JSONL at `~/.pi/agent/pi-blackhole/debug.ndjson`.
- Config lives at `~/.pi/agent/pi-blackhole/pi-blackhole-config.json`; cooldowns at `pi-blackhole-cooldown.json`. `PI_BLACKHOLE_PASSIVE=true` disables compaction + memory entirely.
