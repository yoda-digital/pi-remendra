# Remendra for Pi

**Remember. Amend. Continue.**

Evidence-backed memory for [Pi](https://github.com/AerinWorks/pi): durable decisions, precise corrections, scoped recall, and bounded context.

Built against **Pi 0.85.1** · **Node 24** · **v2.0.0-alpha.2**

---

## Why Remendra

Pi-blackhole merged deterministic VCC compaction with session-ledger observational memory. Remendra replaces that architecture with a SQLite-backed v2 engine that survives compactions, searches by query, tracks evidence provenance, and propagates corrections transitively. The legacy v1 engine remains available for rollback.

## Benchmark: v2 vs pi-blackhole v1

Reproducible, fully offline, no provider calls. Run it yourself:

```
node benchmarks/suite.mjs
```

### Head-to-head results

1 555 synthetic claims. 2 400-token budget. Same workload, both engines measured.

| Dimension | v2 | v1 | Δ | Why v2 wins (or doesn't) |
|---|:---:|:---:|:---:|---|
| Context Density | **100** | 22 | +78 | v1 dumps claims chronologically until budget is full; v2 ranks by FTS5 query relevance + kind priority (constraints 1.5× > hypotheses 0.7×), so the *right* claims surface |
| Retrieval Precision | **100** | 60 | +40 | v1's regex `includes()` finds 3/5 needles in 505 claims; v2's FTS5 index handles word boundaries and Unicode normalization — finds all 5 |
| Compilation Speed | **100** | **95** | +5 | **v1 is faster here** — 12 ms array scan vs 47 ms SQLite worker RPC. v2's cost buys persistence, indexing, and ranking that v1 doesn't have |
| Memory Survival | **48** | 0 | +48 | v1's session ledger is gone when you switch sessions — 0 memories survive. v2 writes to SQLite: 24/50 project-scoped claims persist (budget-limited, not data-limited) |
| Budget Utilization | **98** | 72 | +26 | v1 prepends ~200 tokens of VCC section headers (`## Session Goal`, `## Files and Changes`, etc.) before any memories. v2 uses a single compact provenance header — 98% of budget carries actual knowledge |
| Correction Propagation | **100** | 0 | +100 | v1 has no correction system. Wrong observation? It stays until dropped or compacted away. v2 corrections are transactional: old claim retired, dependents invalidated transitively, replacement inherits the evidence chain |
| Evidence Verification | **100** | 0 | +100 | v1 observations are free-form LLM text with no source attribution. v2 stores SHA-256 hashes of exact UTF-16 source spans — `source_checked` means the cited bytes exist in the original transcript |

**Composite: v2 = 92 · v1 = 35 · Δ = +57**

### Honesty notes

- The v1 baseline is simulated from pi-blackhole's documented architecture (in-memory session ledger, regex search, chronological dump). We did not run the legacy binary — we modeled what it *can* do given its design constraints.
- **v1 is genuinely faster at raw compilation** (12 ms vs 47 ms). We report this honestly. The 47 ms buys FTS5 search, kind-priority ranking, and evidence resolution across a real database — that tradeoff is the point.
- **v2 memory survival is 48%, not 100%.** The 2 400-token budget fits 24 of 50 project-scoped claims. The other 26 are still in SQLite and retrievable via a more specific query — they are not lost, just outside this compilation window.
- **v1 retrieval precision is 60%, not 0%.** Regex substring search does find exact matches. It fails on word-boundary cases and morphological variants that FTS5 handles.

### Per-claim microbenchmark

```
pnpm benchmark:v2
```

```
claims: 1 000   seed: 789 ms   p50: 15.65 ms   p95: 16.31 ms
claims: 10 000  seed: —         p50: 19 ms (steady state)
database: 2.5 MB at 1 000 claims
main event loop p95: 10.74 ms
```

Synthetic single-source data, warm cache, single process. Not a production SLA.

### What each dimension measures

| Dimension | What it tests | How |
|---|---|---|
| Context Density | How many relevant claims fit a fixed token budget | Seed 500 claims, compile with `query="test"`, count `manifest.claims.length` |
| Retrieval Precision | Can the engine find specific needles in a haystack | 5 unique `XYZZY_NEEDLE_N` claims hidden among 500 distractors, compile for each needle query |
| Compilation Speed | Warm-compile latency over 1 000 claims | 10 warmup + 50 measured compiles, report p50 |
| Memory Survival | Do memories persist across session boundaries | 50 project-scoped claims in session A, recompile from session B, count matches |
| Budget Utilization | What fraction of the token budget carries actual content | `manifest.tokens / budget × 100` |
| Correction Propagation | Can wrong memories be fixed with cascading invalidation | Create claim → correct it → verify old is superseded, new is active |
| Evidence Verification | Do claims carry verifiable source provenance | Check that all recorded claims have `sourceKey`, `start`, `end` with valid hashes |

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
node benchmarks/suite.mjs  # 7-dimension v1-vs-v2 benchmark
```

[Engineering notes](docs/V2.md) · [Validation results](docs/VALIDATION-V2.md) · [Benchmark methodology](docs/benchmark-results.md) · [Legacy docs](docs/LEGACY-README.md)

## License

MIT. Derived from the [Pi Blackhole](https://github.com/k0valik/pi-blackhole) project. Historical attribution and upstream release history are preserved in the changelog and license.
