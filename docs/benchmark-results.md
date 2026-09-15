# Benchmark methodology

Remendra includes a synthetic benchmark suite (`benchmarks/suite.mjs`) and a per-claim microbenchmark (`scripts/v2-benchmark.mjs`). Both run offline with no provider calls.

## What the suite measures

The suite seeds synthetic claims into a fresh SQLite database, then exercises the v2 engine on five operations:

| Test | What it verifies | How |
|---|---|---|
| Compilation density | How many claims fit a 2 400-token context budget | Seed 500 claims, compile with a query, count `manifest.claims.length` |
| FTS5 retrieval | Whether the engine can find specific records | 5 unique needle strings among 500 distractors; compile for each, check presence |
| Compilation latency | Warm-compile time over 1 000 claims | 10 warmup + 50 measured compiles, report p50 |
| Cross-session persistence | Whether project-scoped claims survive a session switch | 50 claims in session A, recompile from session B |
| Budget utilization | Fraction of the token budget used for actual content | `manifest.tokens / budget` |

Run it:

```
node benchmarks/suite.mjs
```

## What the microbenchmark measures

The per-claim benchmark (`pnpm benchmark:v2`) seeds N claims sharing one source, then measures the full compile path (worker RPC + FTS5 retrieval + packet assembly):

```
pnpm benchmark:v2         # default: 10 000 claims
pnpm benchmark:v2 1000    # or specify a count
```

## Limitations

These are synthetic smoke tests, not production workload simulations.

- All claims share a single source (real projects have hundreds of sessions)
- No provider latency (the observer and embedding endpoints are not called)
- Warm cache, single process, local SQLite
- The token counter uses `ceil(UTF-8 bytes / 3)`, which overestimates non-ASCII text by 2-3x
- Cross-session persistence test uses explicit `visibility: "project"` claims; automatically extracted claims default to lineage scope and require explicit promotion

The numbers are useful for regression detection and order-of-magnitude performance expectations. They are not a production SLA.
