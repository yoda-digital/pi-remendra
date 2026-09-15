# Remendra

Persistent memory for [Pi](https://github.com/AerinWorks/pi). Stores what you tell it, learns from your sessions, and puts the right memories back in context when you need them.

**v2.0.0-alpha.2** · Pi 0.85.1 · Node 24

## What it does

Remendra watches your Pi sessions, extracts structured memories (facts, decisions, constraints, procedures), and stores them in SQLite with full-text search. When Pi assembles context for the next turn, Remendra injects the memories that match your current query, ranked by relevance and claim type. Memories survive across sessions, branches, and compactions.

If a memory is wrong, you correct it. The old version is retired, its dependents are invalidated transitively, and the replacement inherits the evidence chain. This happens in one transaction.

## Install

```bash
pi install git:github.com/yoda-digital/pi-remendra
```

Then `/reload`, `/remendra doctor`, `/remendra help`.

Development checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
pi install /absolute/path/to/pi-remendra
```

## Usage

```
/remendra remember {"kind":"constraint","text":"Always back up before migrating production."}
/remendra search migration
/remendra why MEMORY_ID
/remendra correct MEMORY_ID {"text":"Create and verify a backup before every production migration."}
/remendra pin MEMORY_ID
/remendra promote MEMORY_ID project
```

Commands: `search`, `history`, `why`, `remember`, `correct`, `pin`, `unpin`, `hide`, `show`, `retract`, `forget`, `erase`, `accept`, `promote`, `trial`, `learn`, `embed`, `semantic`, `gaps`, `budget`, `packet`, `checkpoint`, `doctor`, `settings`, `export`, `backup`, `import`, `migrate`, `link-project`, `index-sessions`.

The `recall` tool is available to the agent automatically. Modes: `memory`, `history`, `source`, `regex`, `file`, `touched`.

## How it works

The extension hooks into Pi's lifecycle:

1. **Ingestion.** New session entries are converted to source records with SHA-256 content hashes and stored in SQLite.
2. **Background learning.** After the agent settles, an observer model extracts structured claims from unprocessed source chunks. Each claim carries evidence: exact character spans into the stored source text. At most 4 batches per settled turn, 2 attempts per batch.
3. **Context compilation.** Before each agent turn, Remendra compiles a memory packet. FTS5 matches the current query against stored claims. Results are ranked by search score and claim-type priority (constraints rank above hypotheses). The packet fits within a measured token budget and includes provenance metadata.
4. **Corrections.** When you correct a memory, the old claim is superseded, its evidence spans are retired, dependent claims are invalidated recursively, and the replacement is recorded with its own evidence.

Memories you create with `/remendra remember` are project-scoped by default. Observer-extracted claims start at lineage scope (current session branch) and are auto-promoted to project scope at session end if they are verified and non-hypothetical. Accepting, pinning, or correcting a lineage claim also promotes it immediately. You can still promote or scope memories manually with `/remendra promote ID project`. User-scoped memories persist across projects when `includeUser` is enabled.

Auto-promotion is configurable: `autoPromote: "full"` (default), `"user-actions"` (only on accept/pin/correct), or `"off"` (old behavior).

## Configuration

Default storage: `~/.pi/agent/pi-remendra/v2/`. Override with `PI_REMENDRA_HOME`.

```
/remendra settings                              # view current config
/remendra settings {"observer":false}           # pause background learning
/remendra settings {"mode":"shadow"}            # compile without injecting
/remendra settings {"mode":"recall"}            # disable learning entirely
/remendra settings {"contextMode":"policy"}     # cache-stable injection (KV-friendly)
/remendra index-sessions                        # index all past Pi sessions for search
```

Full default config: [example-config.json](example-config.json).

The daily token budget (default 80 000) limits how many tokens background learning can spend. Use `/remendra budget` to check.

## Optional semantic search

If you run an OpenAI-compatible embedding endpoint:

```
/remendra settings {"embeddings":{"endpoint":"http://127.0.0.1:8000/v1/embeddings","model":"YOUR_MODEL"}}
/remendra embed
/remendra semantic database configuration
```

HTTPS required for remote endpoints. Loopback HTTP works. No model is downloaded automatically.

## Performance

Per-claim compilation latency on 1 000 synthetic claims (warm cache, single process):

```
p50: 16 ms    p95: 16 ms    database: 2.5 MB
```

Run the benchmarks yourself:

```
pnpm benchmark:v2            # per-claim microbenchmark
node benchmarks/suite.mjs    # smoke test suite
```

These are synthetic tests. Real performance depends on corpus size, query complexity, and provider latency. See [docs/benchmark-results.md](docs/benchmark-results.md) for methodology and limitations.

## How Remendra compares

There are 50+ memory extensions for Pi. Here is an honest comparison with the most popular ones.

| Feature | Remendra | pi-memory | pi-hermes-memory | pi-memory-mem0 |
|---------|----------|-----------|-----------------|---------------|
| Monthly installs | git-only | 39K | 28K | 32K |
| Storage | SQLite + FTS5 | Markdown files | Markdown + SQLite | Mem0 backend |
| Search | FTS5 trigram + optional embeddings | qmd keyword/semantic/hybrid | FTS5 trigram + session search | Mem0 semantic |
| Background learning | Observer extracts typed claims | Exit summaries | Background review every 10 turns | Passive every-turn capture |
| Corrections | Transactional: supersede + invalidate dependents recursively | Overwrite | Category-based | Overwrite |
| Evidence provenance | Exact character spans into source text | None | None | None |
| Typed claims | 7 types with ranking weights | None | 6 categories | None |
| Procedure validation | 2-trial per-environment verification | None | SKILL.md export | None |
| Conflict detection | Subject/predicate dispute flagging | None | None | None |
| Revision history | Full audit trail | None | None | None |
| Session history search | `/remendra index-sessions` | No | Yes | No |
| KV cache stability | Policy-only mode option | Snapshot mechanism | Policy-only mode | N/A |
| CJK search | FTS5 trigram (3+ chars) | Via qmd | FTS5 trigram | Semantic |
| Privacy | Fully local, nothing leaves disk | Fully local | Fully local | Cloud by default |
| Complexity | 4,500 lines, 17 modules | 600 lines, 1 file | Large, multi-file | Backend-dependent |

**Where Remendra is stronger:** correction propagation with dependency invalidation, evidence provenance with exact source spans, typed claims with ranking, procedure trial validation, conflict detection, revision audit trail, privacy.

**Where others are stronger:** pi-memory is simpler and human-editable (plain markdown). pi-hermes-memory has secret scanning and skill export. pi-memory-mem0 has zero-effort semantic capture with no configuration.

**Pick Remendra when** you manage long-lived projects across many sessions and care about correction integrity — when you fix a wrong memory, everything that depended on it gets invalidated automatically. You want full provenance: every memory traces back to exact character offsets in the original conversation.

**Pick something else when** you want the simplest possible setup (pi-memory), cloud-backed semantic search (pi-memory-mem0), or bulk session indexing with native skill export (pi-hermes-memory).

## Tested on

Linux, Windows, macOS · Node 24 · Pi 0.85.1. CI runs the full test suite on all three platforms.

124 tests across 10 files: store operations, compilation, observer parsing, worker lifecycle, embeddings, cross-platform paths, concurrent SQLite access, sustained growth (2000+ claims), and token estimation accuracy.

The [validation document](docs/validation.md) is the honest accounting of what has been tested and what has not.

**Remaining gaps:** live-provider extraction quality and multi-day retention have not been soak-tested with real providers.

## Development

```bash
pnpm build              # tsup → dist/
pnpm typecheck          # tsc --noEmit
pnpm lint               # eslint
pnpm test               # vitest
pnpm test:smoke         # real Pi SDK smoke
pnpm benchmark:v2       # per-claim latency
```

[Engineering notes](docs/engineering.md) · [Validation](docs/validation.md) · [Benchmark methodology](docs/benchmark-results.md)

## License

MIT.
