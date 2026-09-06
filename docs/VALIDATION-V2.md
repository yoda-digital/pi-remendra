# Remendra v2 validation record

Version: **2.0.0-alpha.2**. Validation date: **2026-09-06**.

Remendra's rebrand and distribution changes were validated on Node **24.15.0** with Pi packages **0.85.1**:

- Full suite: **1,572 tests passed across 97 files**.
- Focused v2 suite: **64 tests passed across five files**.
- Build, TypeScript type checking, ESLint, and repository formatting checks passed.
- Native Pi SDK smoke tests passed in foreground-only and background-observer modes with no extension errors.
- A clean temporary Pi home successfully installed commit `53f1e69` from GitHub with `pi install git:github.com/yoda-digital/pi-remendra`; the installed CLI reported SQLite `quick_check: ok`, and the committed host extension and worker were present.
- Compatibility coverage confirms that Remendra accepts Blackhole v2 exports and removes stale Blackhole v2 packets.

The engine source was reconstructed from the audited base and implementation patch recorded below. The historical benchmark measurements in this document were recorded for the pre-rebrand alpha on Node 24.19.0; they remain implementation provenance, not a performance claim for every environment.

## Engine provenance and original validation

Base repository: `k0valik/pi-blackhole`, commit `270aa0912800b2b7ce64414ef4247be84106d8f8` (0.4.10).
Implementation branch: `feat/blackhole-v2`.
Pi reference source: `earendil-works/pi`, commit `da840b6216578c2a571d0374ac6a2091a83f9d91` (0.85.1).
Runtime exercised: Linux, Node **24.19.0**, Pi packages **0.85.1**, TypeScript **6.0.3**.

## Checks completed

- Original baseline: **1,508 tests passed** before implementation.
- Combined suite at the original validation point: **1,571 tests passed across 97 files**; no skipped test files in that run.
- New v2 suite at the original validation point: **63 tests across five files**.
- Bundles build successfully: host extension, storage worker, standalone CLI, and legacy entry.
- TypeScript type checking and repository ESLint pass.
- Repository formatting checks pass.
- Real Pi resource loader and SDK load the built extension and deliver a source-attributed memory packet to a deterministic foreground provider.
- The same SDK smoke test also exercises `ctx.modelRegistry.complete` through a registered custom provider: one foreground request, one background request, committed usage, and no observed extension errors.

The test suite uses temporary directories, synthetic sessions, deterministic providers, and a loopback HTTP embedding fixture. It does not use personal sessions, production databases, real API credentials, or paid inference.

## Correctness covered

Storage restart and integrity; explicit project identity; project/session/branch isolation; opt-in global scope; Unicode search; numeric and negation distinctions; evidence hash/span validation; atomic correction rollback; revision conflicts; transitive dependency invalidation; structured contradictions; candidate authority boundaries; valid-time intervals; source replacement; source redaction and excluded paths; reversible hiding and permanent retraction; logical erasure and re-import suppression; direct legacy migration; consistent backups; candidate-only export merge; scoped vectors; procedure trials and environment matching; exclusive extraction leases; failed/empty extraction; citation rejection; crash reservation recovery; chunk coverage; rendered packet budgets; observer JSON and exact-quote parsing; cancellation of nonresponsive providers; worker deadlines; original transcript branch access; Pi packet deduplication and tool-pair preservation; shadow mode; low headroom; storage-failure fallback; and embedding validation/accounting.

The native SDK smoke test exposed a disposed-context race that the isolated tests did not catch. The implementation now avoids background UI updates after Pi invalidates a context and observes Pi's context abort signal.

## Synthetic performance measurement

Command: `node scripts/v2-benchmark.mjs`.

- Dataset: **10,000 synthetic claims sharing one source**, including 100 constraint anchors.
- Measured operation: worker RPC, scoped lexical retrieval, source/dependency eligibility checks, and full context-packet compilation.
- Warm-up: 10 requests. Recorded sample count: 50.
- Median: **19.01 ms**.
- 95th percentile: **23.83 ms**.
- Seed time: **1,755 ms**.
- Final SQLite database: **23,326,720 bytes**.
- Main event-loop delay p95: **10.57 ms**, measured with a 10 ms sampling resolution.

The earlier implementation measured 41.82 ms median and 49.75 ms p95 on the same fixture. Prepared-statement reuse and a direct inactive-claim query reduced repeated work. Packet compilation also uses one consistent SQLite read snapshot.

These are single-machine, warm-cache, single-process synthetic results. One shared source understates the costs of a large diverse source corpus. There is no provider latency in this benchmark. These measurements are **not** a production SLA, a cross-platform claim, or a guarantee for every 10,000-record collection.

## Release gates still open

- Live-provider extraction quality, long-running cancellation, rate-limit behavior, and billing reconciliation.
- Windows and macOS validation; complete Bun/compiled-Pi runtime validation.
- Multi-day workloads, realistic large source corpora, simultaneous active Pi sessions, and power-loss fault injection.
- A provider-specific exact tokenizer if a strict provider-token bound is required.

The package is an installable alpha, not a completed production certification. See V2.md for features intentionally outside this release's scope and the boundaries of logical erasure, source verification, historical recall, and import authority.
