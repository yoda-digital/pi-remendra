# Remendra

Persistent memory for [Pi](https://github.com/AerinWorks/pi). Learns from your sessions, corrects itself when wrong, and gets smarter over time.

**v2.0.0** · Pi 0.85.1 · Node ≥22

## What it does

Remendra learns automatically from your Pi sessions — no commands needed. It extracts facts, decisions, constraints, and procedures, then puts the right memories back in context when you need them. Memories survive across sessions, branches, and compactions.

If a memory is wrong, you correct it. Everything that depended on the wrong memory gets fixed too — automatically, in one transaction. No stale knowledge accumulating silently.

## Install

```bash
pi install git:github.com/yoda-digital/pi-remendra
```

Then `/reload`. Remendra shows setup guidance on first run automatically.

Development checkout:

```bash
pnpm install --frozen-lockfile
pnpm build
pi install /absolute/path/to/pi-remendra
```

## Usage

Remendra works automatically — it learns from every session with no intervention. You can also interact with it directly:

```
/remendra search migration                 # find what it knows
/remendra remember Always back up first    # teach it something
/remendra correct 42 Back up AND verify    # fix a wrong memory
/remendra why 42                           # see where a memory came from
/remendra doctor                           # health check
/remendra settings                         # view configuration
```

For typed claims, pass JSON: `/remendra remember {"kind":"constraint","text":"Always back up before migrating production."}`.

The `recall` tool is available to the agent automatically. Use `/remendra help all` for the full command reference.

<details>
<summary><strong>How it works</strong></summary>

The extension hooks into Pi's lifecycle:

1. **Ingestion.** New session entries are converted to source records with SHA-256 content hashes and stored in SQLite.
2. **Background learning.** After the agent settles, an observer model extracts structured claims from unprocessed source chunks. Each claim carries evidence: exact character spans into the stored source text. At most 4 batches per settled turn, 2 attempts per batch.
3. **Context compilation.** Before each agent turn, Remendra compiles a memory packet. FTS5 matches the current query against stored claims. Results are ranked by search score and claim-type priority (constraints rank above hypotheses). The packet fits within a measured token budget and includes provenance metadata.
4. **Corrections.** When you correct a memory, the old claim is superseded, its evidence spans are retired, dependent claims are invalidated recursively, and the replacement is recorded with its own evidence.

Memories you create with `/remendra remember` are project-scoped by default. Observer-extracted claims start at lineage scope (current session branch) and are auto-promoted to project scope at session end if they are verified and non-hypothetical. Accepting, pinning, or correcting a lineage claim also promotes it immediately. You can still promote or scope memories manually with `/remendra promote ID project`. User-scoped memories persist across projects when `includeUser` is enabled.

Auto-promotion is configurable: `autoPromote: "full"` (default), `"user-actions"` (only on accept/pin/correct), or `"off"` (old behavior).
</details>

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
| Storage | SQLite + FTS5 | Markdown files | Markdown + SQLite | Mem0 backend |
| Search | FTS5 trigram + optional embeddings | qmd keyword/semantic/hybrid | FTS5 trigram + session search | Mem0 semantic |
| Background learning | Observer extracts typed claims | Exit summaries | Background review every 10 turns | Passive every-turn capture |
| Corrections | Transactional: supersede + invalidate dependents recursively | Overwrite | Category-based | Overwrite |
| Evidence provenance | Exact character spans into source text | None | None | None |
| Typed claims | 7 types with ranking weights | None | 6 categories | None |
| Procedure validation | 2-trial per-environment verification | None | SKILL.md export | None |
| Secret scanning | OpenAI, GitHub, AWS, Stripe, Slack, DB URIs, PEM keys | None | Injection/exfiltration detection | None |
| Conflict detection | Subject/predicate dispute flagging | None | None | None |
| Revision history | Full audit trail | None | None | None |
| Session history search | `/remendra index-sessions` | No | Yes | No |
| KV cache stability | Policy-only mode option | Snapshot mechanism | Policy-only mode | N/A |
| CJK search | FTS5 trigram (3+ chars) | Via qmd | FTS5 trigram | Semantic |
| Node compatibility | Node 22+ (24 built-in, 22 via better-sqlite3) | Node 22+ | Node 22+ | N/A |
| Privacy | Fully local, nothing leaves disk | Fully local | Fully local | Cloud by default |

**Where Remendra is stronger:** self-correcting memories (fix one, dependents update automatically), evidence provenance with exact source spans, typed claims with ranking, procedure trial validation, conflict detection, full revision audit trail, comprehensive secret scanning, fully local privacy.

**Where others are stronger:** pi-memory is simpler and human-editable (plain markdown). pi-hermes-memory has native skill export (SKILL.md). pi-memory-mem0 has zero-effort semantic capture with no configuration.

**Pick Remendra when** you manage long-lived projects across many sessions and care about correction integrity — when you fix a wrong memory, everything that depended on it gets invalidated automatically. You want full provenance: every memory traces back to exact character offsets in the original conversation.

**Pick something else when** you want the simplest possible setup (pi-memory), cloud-backed semantic search (pi-memory-mem0), or native skill export (pi-hermes-memory).

## Tested on

Linux, Windows, macOS · Node 22+ (Node 24 uses built-in SQLite; Node 22 uses `better-sqlite3`) · Pi 0.85.1. CI runs the full test suite on all three platforms.

128 tests across 10 files: store operations, compilation, observer parsing, worker lifecycle, embeddings, cross-platform paths, concurrent SQLite access, sustained growth (2000+ claims), token estimation accuracy, and secret redaction patterns.

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
