# Changelog

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
