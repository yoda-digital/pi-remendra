# Contributing to Remendra

## Development setup

```bash
git clone https://github.com/yoda-digital/pi-remendra.git
cd pi-remendra
pnpm install
pnpm build
```

## Commands

```bash
pnpm build          # build with tsup
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint
pnpm test           # vitest (128 tests)
pnpm test:smoke     # real Pi SDK smoke test
pnpm benchmark:v2   # per-claim latency benchmark
```

## Before submitting a PR

1. Run `pnpm verify` (typecheck + lint + format check + tests).
2. Add tests for new functionality.
3. Use conventional commit messages (`feat:`, `fix:`, `chore:`, `docs:`).

## Architecture overview

- `src/v2/extension.ts` — Pi lifecycle hooks, command dispatch (the entry point)
- `src/v2/store.ts` — SQLite memory store (the core, ~1850 lines)
- `src/v2/service.ts` — RPC service exposed to the worker thread
- `src/v2/compiler.ts` — Context packet compilation (what gets injected)
- `src/v2/observer.ts` — Claim extraction from session text
- `src/v2/learner.ts` — Background extraction orchestration
- `src/v2/text.ts` — Token estimation, redaction, normalization
- `src/v2/sqlite.ts` — Database abstraction (Node 24 built-in / Node 22 better-sqlite3 / Bun)
- `src/v2/worker.ts` — Worker thread entry point
- `src/v2/client.ts` — RPC client for the worker

Store operations run in a dedicated worker thread. Any new feature that touches the store needs a corresponding RPC method in `service.ts`.

## Reporting bugs

Open an issue with:
- What you expected vs what happened
- Pi version, Node version, OS
- Output of `/remendra doctor`
