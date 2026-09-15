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

Commands: `search`, `history`, `why`, `remember`, `correct`, `pin`, `unpin`, `hide`, `show`, `retract`, `forget`, `erase`, `accept`, `promote`, `trial`, `learn`, `embed`, `semantic`, `gaps`, `budget`, `packet`, `checkpoint`, `doctor`, `settings`, `export`, `backup`, `import`, `migrate`, `link-project`.

The `recall` tool is available to the agent automatically. Modes: `memory`, `history`, `source`, `regex`, `file`, `touched`.

## How it works

The extension hooks into Pi's lifecycle:

1. **Ingestion.** New session entries are converted to source records with SHA-256 content hashes and stored in SQLite.
2. **Background learning.** After the agent settles, an observer model extracts structured claims from unprocessed source chunks. Each claim carries evidence: exact character spans into the stored source text. At most 4 batches per settled turn, 2 attempts per batch.
3. **Context compilation.** Before each agent turn, Remendra compiles a memory packet. FTS5 matches the current query against stored claims. Results are ranked by search score and claim-type priority (constraints rank above hypotheses). The packet fits within a measured token budget and includes provenance metadata.
4. **Corrections.** When you correct a memory, the old claim is superseded, its evidence spans are retired, dependent claims are invalidated recursively, and the replacement is recorded with its own evidence.

Memories default to lineage scope (current session branch). You promote them to project or user scope explicitly. Project memories persist across sessions. User memories persist across projects.

## Configuration

Default storage: `~/.pi/agent/pi-remendra/v2/`. Override with `PI_REMENDRA_HOME`.

```
/remendra settings                              # view current config
/remendra settings {"observer":false}           # pause background learning
/remendra settings {"mode":"shadow"}            # compile without injecting
/remendra settings {"mode":"recall"}            # disable learning entirely
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

## Known limits

This is alpha software. The [validation document](docs/validation.md) is the honest accounting of what has been tested and what has not.

- Token estimation uses `ceil(UTF-8 bytes / 3)`, which overestimates non-ASCII text by 2-3x. The [engineering notes](docs/engineering.md) document the planned fix.
- Automatically extracted claims default to lineage scope. Cross-session availability requires explicit `/remendra promote ID project`.
- Lexical search candidates are capped at 600 rows. Omissions are visible in the response.
- Live-provider extraction quality, Windows/macOS, multi-day workloads, concurrent sessions, and power-loss behavior have not been validated.
- The v2 test suite is 73 tests across 5 files.

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
