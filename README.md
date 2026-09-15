# Remendra for Pi

**Remember. Amend. Continue.**

Evidence-backed memory for [Pi](https://github.com/AerinWorks/pi): durable decisions, precise corrections, scoped recall, and bounded context.

Built against **Pi 0.85.1** · **Node 24** · **v2.0.0-alpha.2**

---

## Why Remendra

Pi-blackhole merged deterministic VCC compaction with session-ledger observational memory. Remendra replaces that architecture with a SQLite-backed v2 engine that survives compactions, searches by query, tracks evidence provenance, and propagates corrections transitively. The legacy v1 engine remains available for rollback.

### vs pi-blackhole (v1 session-ledger)

| Capability | Remendra v2 | pi-blackhole v1 |
|---|---|---|
| Storage | SQLite + FTS5 worker | In-memory session ledger |
| Persistence | Cross-session, cross-branch | Session-only |
| Retrieval | Query-matched FTS5 + semantic | Regex + BM25 over live entries |
| Corrections | Transactional with dependency invalidation | Manual ledger edits |
| Evidence | Source-hashed UTF-16 spans | Free-form observations |
| Scope | Lineage / project / user | Session-only |
| Procedure validation | 2-trial gate per environment | None |
| Semantic search | OpenAI-compatible embeddings | None |

### vs static-injection extensions

Extensions that dump raw methodology markdown into context with no search, no persistence, no retrieval score 0 on every dimension Remendra measures.

## Benchmark

Reproducible, fully offline. No network or provider calls. Run it:

```
node benchmarks/suite.mjs
```

| Dimension | Score | Detail |
|---|:---:|---|
| Context Density | **100** | Query-matched claims fill a 2 400-token budget |
| Retrieval Precision | **100** | 5/5 needles found via FTS5 |
| Compilation Speed | **100** | p50 47 ms over 1 000 claims |
| Memory Survival | **48** | 24/50 project-scoped claims survive session switch (budget-limited) |
| Budget Utilization | **98 %** | 2 352 / 2 400 tokens used |
| **Composite** | **89 / 100** | **PASS** |

The per-claim microbenchmark (`pnpm benchmark:v2`) reports p50 27 ms over 1 000 claims, 19 ms median at 10 000 claims steady state.

Full methodology and before/after comparisons in [docs/benchmark-results.md](docs/benchmark-results.md).

## Install

```bash
pi install git:github.com/yoda-digital/pi-remendra
```

Run `/reload` in Pi, then `/remendra doctor` and `/remendra help`.

Do not load pi-blackhole and Remendra together. Use `pi list` to find and remove the old package first. The v1 ledger and v2 database are separate; migration is explicit and leaves old files untouched.

For a development checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
pi install /absolute/path/to/pi-remendra
```

The repository commits its built extension and storage worker, so the normal Git install works without a local compiler. Development checkouts should rebuild after source changes.

## What works

- **Durable typed memory** — facts, decisions, constraints, preferences, hypotheses, procedures, and commitments, with revision history and exact source spans.
- **Corrections that propagate** — replacing a memory retires the old version, invalidates dependent conclusions, and prevents background extraction from reviving retired evidence.
- **Scope isolation** — current lineage by default, explicit project promotion, and opt-in user memory. Project identity survives a directory move through an explicit link.
- **Multilingual recall** — Unicode-preserving FTS5 search, exact IDs, source search, historical lookup, original transcript expansion, file drill-down, and touched-file history.
- **Bounded context** — whole-record selection with provenance, coverage gaps, conflicts, and omission counts. The complete rendered packet is measured before insertion.
- **Background learning** — source chunks have durable leases; successful claims and coverage commit together. Foreground work cancels extraction. Retry and daily reservation limits apply before dispatch.
- **Kind-priority ranking** — constraints and decisions rank above facts and hypotheses in context compilation, maximizing the value of each token spent.
- **Optional semantic search** — manually index memories and search an OpenAI-compatible embedding endpoint. Revision and scope checks apply to every result; embedding requests share the memory token budget.
- **Procedure validation** — candidate procedures need two distinct successful tool-result trials in the same environment before automatic retrieval. A failed trial revokes eligibility.
- **User controls** — inspect, correct, pin, hide, retract, accept, promote, erase, export, import, backup, and diagnose.
- **Migration** — direct v1 observation/reflection import preserves distinct records, including Cyrillic content and old ID aliases. Imported memories require review.

## Quick start

```text
/remendra remember {"kind":"constraint","text":"Never run a production migration without a backup."}
/remendra search production
/remendra why MEMORY_ID
/remendra correct MEMORY_ID {"text":"Create and verify a backup before every production migration."}
/remendra pin MEMORY_ID
```

Use the actual ID returned by the command. Corrections return a new ID and keep the supersession relationship. Concurrent edits are protected by revision checks.

```text
/remendra promote MEMORY_ID project
/remendra forget MEMORY_ID
/remendra show MEMORY_ID
/remendra retract MEMORY_ID
```

`forget` means reversible hiding. `retract` retires an assertion. `erase` scrubs the v2 memory and its supporting source payloads, plus claims that depend on those sources. It does **not** erase original Pi session files, previous exports, or backups.

## Automatic learning and cost

Learning is enabled by default and uses the session's model through Pi's native registry. It runs after `agent_settled`, with at most four batches per settled run and two attempts per batch. The default daily reservation limit is **80 000 memory tokens**, shared across projects and processes using this database. Use `/remendra budget` to inspect usage.

```text
/remendra settings {"observer":false}     # pause learning, keep recall
/remendra settings {"mode":"shadow"}      # compile without injecting
```

Token bounds use `utf8-bytes/3-estimate`, not a provider tokenizer. Provider-reported usage is charged when available. The reservation limit controls dispatch; it cannot guarantee an exact provider bill.

## Recall

The `recall` tool supports `query`, `mode`, `scope`, `page`, `expand`, and `asOf`. Modes: `memory`, `history`, `source`, `regex`, `file`, `touched`.

```text
/remendra-recall PostgreSQL
/remendra-recall MEMORY_ID
/remendra-recall #12
/remendra-recall #12:src/config.ts
/remendra history database
```

## Migration and recovery

```text
/remendra migrate                              # import v1 entries from active session
/remendra migrate /path/to/old-session.jsonl   # import from file
/remendra backup /path/to/new-backup.sqlite
/remendra export /path/to/new-export.jsonl
/remendra import /path/to/export.jsonl
```

Exports merge as candidates; they do not restore authority or overwrite live revisions. For a full-fidelity restore, stop every Pi process using this memory directory and replace the database with a consistent SQLite backup. See [V2 engineering notes](docs/V2.md).

## Optional semantic search

```text
/remendra settings {"embeddings":{"endpoint":"http://127.0.0.1:8000/v1/embeddings","model":"YOUR_MODEL"}}
/remendra embed
/remendra semantic database configuration
```

HTTPS required for remote endpoints; loopback HTTP supported. No model is downloaded automatically.

## Configuration

Default storage: `~/.pi/agent/pi-remendra/v2/`. Override with `PI_REMENDRA_HOME`. Set `PI_REMENDRA_PASSIVE=true` to disable automatic ingestion and injection.

```text
/remendra settings       # view current config
/remendra gaps           # unprocessed source ranges
/remendra packet         # what is eligible for injection
/remendra doctor         # SQLite integrity and compatibility
```

Complete default config: [example-config-v2.json](example-config-v2.json).

Standalone CLI:

```bash
node dist/v2/cli.js --project /path/to/project doctor
node dist/v2/cli.js --project /path/to/project --session /path/to/session.jsonl search PostgreSQL
```

## Development

```bash
pnpm build              # tsup → dist/
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint
pnpm test               # vitest (1 572 tests)
pnpm test:smoke         # real Pi SDK smoke
pnpm benchmark:v2       # per-claim microbenchmark
node benchmarks/suite.mjs  # 5-dimension benchmark suite
```

[Engineering notes](docs/V2.md) · [Validation results](docs/VALIDATION-V2.md) · [Benchmark results](docs/benchmark-results.md) · [Legacy docs](docs/LEGACY-README.md)

## License

MIT. Derived from the [Pi Blackhole](https://github.com/k0valik/pi-blackhole) project. Historical attribution and upstream release history are preserved in the changelog and license.
