# Changelog

## [2.0.0] - 2026-09-15

### Changed

- **Stable release.** Dropped alpha label after 124 tests, 3-platform CI, and 47-bug audit.
- **Help tier split.** `/remendra help` shows 6 essential commands. `/remendra help all` shows the full 30+ command reference. Reduces first-impression complexity.
- **README rewritten for users.** Usage section leads with plain-text examples. Automatic learning foregrounded. "How it works" collapsed into expandable section.
- **Node 22 support.** Lowered minimum from Node 24 to Node 22. Node 24 uses built-in `node:sqlite` (zero dependencies). Node 22 uses `better-sqlite3` (optional peer dependency) as fallback.
- **Package description** updated to be user-facing instead of technical.
- **Keywords** expanded: added `pi-package` (pi.dev catalog discovery), `persistent`, `context`, `knowledge`, `long-term`, `learning`.

### Added

- **First-run onboarding.** On first session, shows quick-start commands, observer model guidance, and daily token cost estimate. On subsequent sessions, shows brief memory stats in the status bar.
- **Expanded secret scanning.** `redact()` now catches AWS access keys (`AKIA*`), Stripe keys (`sk_live_`, `sk_test_`, `rk_live_`, `rk_test_`, `pk_live_`, `pk_test_`), Slack tokens (`xoxb-`, `xoxp-`, `xoxs-`, `xapp-`), and database connection URIs (`postgres://`, `mysql://`, `mongodb://`, `redis://`).

## [2.0.0-alpha.2] - 2026-09-15

### Fixed

- 47 bugs identified through comprehensive audit and fixed across 8 batches.
- Cosmetic actions (pin/unpin/show/hide) no longer cascade-invalidate dependent claims.
- `trial()` rejects retracted/superseded procedures and empty source text.
- Scope promotion rejects demotion (user to project).
- Background learner handles undefined token usage without infinite retry loop.
- Session shutdown wrapped in try/catch/finally to prevent worker leaks.
- WAL checkpoint after erase ensures deleted data reaches the main database file.
- Per-call client timeout no longer kills the entire worker on a single slow operation.
- RPC boundary validates actor to prevent scope bypass.
- Import validates required claim fields before casting.
- Observer rejects empty claims; fuzzy fallback 3 collapses whitespace correctly.
- Procedure failure requires 2 consecutive failures to demote from promoted (hysteresis).
- Correction resolves disputes when the superseded claim was the conflicting one.
- Trial evidence no longer appended to claim (stored in trials table, avoids source-erasure fragility).
- Nested transactions use SAVEPOINTs for proper isolation.

### Changed

- README rewritten as product-only documentation. No upstream references.
- Benchmark relabeled as smoke tests with honest limitations.
- Removed work_docs/, legacy planning files, and upstream tracking from repository.
- Removed legacy v1 documentation from docs/.
- Cleaned package.json keywords and file list.

## [2.0.0-alpha.1] - 2026-09-06

### Added

- SQLite-backed memory engine with FTS5 search, source evidence, typed claims, revision history, and lineage/project/user scope.
- Transactional corrections with dependency invalidation and retired evidence spans.
- Bounded context compiler with query-matched FTS5 retrieval and claim-type priority ranking.
- Background extraction with durable leases, token budgets, and cancellation.
- Optional semantic search via OpenAI-compatible embedding endpoint.
- Procedure validation requiring 2 successful trials per environment.
- Standalone CLI, focused test suite, Pi SDK smoke test, and synthetic benchmark.
- Direct v1 migration, JSONL exports, SQLite backups, and diagnostics.

## License

MIT.
