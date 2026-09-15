# Remendra v2 validation record

Version: **2.0.0**. Last validated: **2026-09-15**.

## Current test coverage

- **128 tests across 10 files**, CI on Ubuntu, Windows, and macOS.
- Build, TypeScript type checking, ESLint, and formatting checks pass.
- Native Pi SDK smoke tests pass in foreground-only and background-observer modes.
- Node 24 (built-in `node:sqlite`) and Node 22 (`better-sqlite3` fallback) are both supported.

## What is tested

Storage restart and integrity; explicit project identity; project/session/branch isolation; opt-in global scope; Unicode and CJK trigram search; numeric and negation distinctions; evidence hash/span validation; atomic correction rollback; revision conflicts; transitive dependency invalidation; structured contradictions; candidate authority boundaries; valid-time intervals; source replacement; source redaction (OpenAI, GitHub, AWS, Stripe, Slack, database URIs, PEM keys) and excluded paths; reversible hiding and permanent retraction; logical erasure and re-import suppression; direct legacy migration; consistent backups; candidate-only export merge; scoped vectors; procedure trials and environment matching; exclusive extraction leases; failed/empty extraction; citation rejection; crash reservation recovery; chunk coverage; rendered packet budgets; observer JSON and exact-quote parsing; cancellation of nonresponsive providers; worker deadlines; original transcript branch access; Pi packet deduplication and tool-pair preservation; shadow mode; low headroom; storage-failure fallback; embedding validation/accounting; secret redaction patterns; token estimation accuracy; and session history indexing.

## What is NOT tested

- Live-provider extraction quality with real API providers.
- Multi-day retention and long-running cancellation behavior.
- Rate-limit behavior and billing reconciliation with paid APIs.
- Windows and macOS validation beyond CI test suite (no manual soak tests).
- Bun runtime validation.
- Simultaneous active Pi sessions sharing one database.
- Power-loss fault injection.
- A provider-specific exact tokenizer (the `chars/4` heuristic is used).

## Synthetic performance

Command: `node scripts/v2-benchmark.mjs`.

- Dataset: **10,000 synthetic claims sharing one source**, including 100 constraint anchors.
- Median: **19.01 ms** per-claim compilation. 95th percentile: **23.83 ms**.
- Database size: **23.3 MB**. Seed time: **1,755 ms**.

These are single-machine, warm-cache, single-process results with one shared source. Real performance depends on corpus size, query complexity, and provider latency. Not a production SLA.

## Audit history

- **2026-09-15**: 8-agent parallel audit found 47 bugs (5 critical, 8 high, 16 medium, 18 low). All 47 fixed and verified. 9 regression tests added.
- **2026-09-15**: All 5 known limitations eliminated (token estimation, auto-promotion, search CTE, cross-platform CI, test coverage).
- **2026-09-15**: 3 competitive gaps closed (CJK trigram search, session history, policy-only mode).
- **2026-09-15**: Product transformation — help tier split, first-run onboarding, expanded secret scanning, Node 22 support.
