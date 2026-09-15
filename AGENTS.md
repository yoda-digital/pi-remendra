# AGENTS.md

## Remendra v2

The default entry exports `src/v2/extension.ts`; the package loads `dist/index.js`. Public identifiers: `/remendra`, `remendra-memory`, `PI_REMENDRA_*`, `~/.pi/agent/pi-remendra/v2/`. Uses Pi 0.85.1 hooks, the native model registry, and a SQLite worker. Defaults in `src/v2/config.ts`; contracts in `src/v2/types.ts`. Node 24.

`dist/` is committed because Pi installs Git packages without devDependencies. Rebuild and commit after source changes.

## Commands

```bash
pnpm build          # tsup → dist/
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint
pnpm test           # vitest
pnpm test:smoke     # real Pi SDK smoke
pnpm benchmark:v2   # per-claim latency
pnpm check          # typecheck + lint + fmt:check
```

- CI order: build → typecheck → lint → test → test:smoke → format:check
- pre-commit: lint-staged + typecheck. pre-push: typecheck + test (skipped for docs-only).
- pnpm only (`packageManager: pnpm@11.2.2`). TypeScript pinned to 6.0.3 for @typescript-eslint v8 compat.

## Testing

- Source imports use `.js` extensions; vitest's alias strips them.
- `tests/` is NOT in tsconfig.json.
- Tests are pure unit tests with fake agent loops. No LLM or network calls.
- v2 suite: 124 tests across 10 files in `tests/v2/`.

## Workflow

- `main` is the installable release branch. Every source change includes a rebuilt `dist/`.
- Conventional commits (`feat:`, `fix:`, `chore:`).

## Debugging

- Runtime clone for testing: `~/.pi/agent/git/github.com/yoda-digital/pi-remendra/` — sync changes, `/reload`.
- `PI_REMENDRA_PASSIVE=true` disables ingestion and injection entirely.
