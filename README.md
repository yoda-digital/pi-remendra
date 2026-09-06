# Remendra for Pi

**Remember. Amend. Continue.**

Evidence-backed memory for Pi: durable decisions, precise corrections, scoped recall, and bounded context. **Version 2.0.0-alpha.2**, built against **Pi 0.85.1** on **Node 24**.

V2 is a new default engine. It uses Pi's public extension lifecycle and native model registry. SQLite storage and transcript search run in a worker. Pi continues to own compaction, retries, tool execution, and foreground generation.

## Install

```bash
pi install git:github.com/yoda-digital/pi-remendra
```

Run `/reload` in Pi, then `/remendra doctor` and `/remendra help`.

Do not load Remendra and Pi Blackhole together. Use `pi list` to find and remove or disable the old package first. Blackhole's old ledger and Remendra's database are separate; migration is explicit and leaves the old files untouched.

For a development checkout containing this v2 branch:

```bash
pnpm install --frozen-lockfile
pnpm build
pi install /absolute/path/to/pi-remendra
```

The repository commits its built extension and storage worker, so the normal Git install works without a local compiler. Development checkouts should rebuild after source changes.

## What works

- **Durable typed memory:** facts, decisions, constraints, preferences, hypotheses, procedures, and commitments, with revision history and exact source spans.
- **Corrections that propagate:** replacing a memory retires the old version, invalidates dependent conclusions, and prevents background extraction from reviving retired evidence.
- **Scope isolation:** current lineage by default, explicit project promotion, and opt-in user memory. Project identity survives a directory move through an explicit link.
- **Multilingual recall:** Unicode-preserving FTS5 search, exact IDs, source search, historical lookup, original transcript expansion, file drill-down, and touched-file history.
- **Bounded context:** whole-record selection with provenance, coverage gaps, conflicts, and omission counts. The complete rendered packet is measured before insertion.
- **Background learning:** source chunks have durable leases; successful claims and coverage commit together. Foreground work cancels extraction. Retry and daily reservation limits apply before dispatch.
- **Optional semantic search:** manually index memories and search an OpenAI-compatible embedding endpoint. Revision and scope checks apply to every result; embedding requests share the memory token budget.
- **Procedure validation:** candidate procedures need two distinct successful tool-result trials in the same environment before automatic retrieval. A failed trial revokes eligibility.
- **User controls:** inspect, correct, pin, hide, retract, accept, promote, erase, export, import, backup, and diagnose.
- **Migration:** direct v1 observation/reflection import preserves distinct records, including Cyrillic content and old ID aliases. Imported memories require review.

## Try it

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

Learning is enabled by default and uses the session's model through Pi's native registry. It runs after `agent_settled`, with at most four batches per settled run and two attempts per batch. The default daily reservation limit is **80,000 memory tokens**, shared across projects and processes using this database. Use `/remendra budget` to inspect usage.

To pause automatic learning while retaining recall:

```text
/remendra settings {"observer":false}
```

To compile packets without injecting them:

```text
/remendra settings {"mode":"shadow"}
```

Token bounds use the explicitly named `utf8-bytes/3-estimate`, not a provider tokenizer. Provider-reported usage is charged when available. Unknown usage after a crash or cancellation is charged conservatively at the reservation. The reservation limit controls dispatch; it cannot guarantee an exact provider bill. Native Pi foreground and compaction usage are outside this memory budget.

## Recall

The `recall` tool supports `query`, `mode`, `scope`, `page`, `expand`, and `asOf`. Modes are `memory`, `history`, `source`, `regex`, `file`, and `touched`.

```text
/remendra-recall PostgreSQL
/remendra-recall MEMORY_ID
/remendra-recall #12
/remendra-recall #12:src/config.ts
/remendra history database
```

For original transcript operations, `scope:all` means all branches of the current Pi session. For indexed source search, it means all ingested sessions in this project. Memory search always respects visibility: project memories must have been explicitly promoted. Search windows and output are bounded; use more specific queries when results are crowded.

## Migration and recovery

```text
/remendra migrate
/remendra migrate /absolute/path/to/old-session.jsonl
/remendra history
/remendra why OLD_12_CHARACTER_ID
/remendra accept MEMORY_ID
```

`migrate` without a path reads the active session's v1 custom entries. A file may contain JSONL session entries, folded memory details, or pending observation arrays. Import does not reuse v1 fuzzy deduplication. The old files are untouched.

```text
/remendra backup /absolute/path/to/new-backup.sqlite
/remendra export /absolute/path/to/new-export.jsonl
/remendra import /absolute/path/to/export.jsonl
```

Exports merge as candidates; they do not silently restore authority or overwrite live revisions. For a full-fidelity restore, stop every Pi process using this memory directory and replace the database with a consistent SQLite backup. See [V2 engineering notes](docs/V2.md).

## Optional semantic search

Configure an endpoint you operate or choose. No model is downloaded automatically.

```text
/remendra settings {"embeddings":{"endpoint":"http://127.0.0.1:8000/v1/embeddings","model":"YOUR_MODEL"}}
/remendra embed
/remendra semantic database configuration
```

`embed` indexes up to 32 eligible memories per invocation within the input budget. Run it again to index more. HTTPS is required for remote endpoints; loopback HTTP is supported. If authentication is required, set an environment variable and specify its name with `apiKeyEnv`. Semantic search is explicit; ordinary context compilation stays local and lexical.

## Configuration and diagnostics

Default storage: `~/.pi/agent/pi-remendra/v2/`. `PI_REMENDRA_HOME` overrides that directory. `PI_REMENDRA_ENVIRONMENT` sets the environment used to match validated procedures. `PI_REMENDRA_PASSIVE=true` disables automatic ingestion and injection.

`/remendra settings` shows current configuration. The complete default file is [example-config-v2.json](example-config-v2.json). Configuration changes are validated and written atomically. External file edits take effect on `/reload`.

`/remendra gaps` shows unprocessed source ranges. `/remendra packet` explains exactly what is eligible for injection. `/remendra checkpoint` previews a bounded memory-only checkpoint; it never replaces native Pi compaction. `/remendra doctor` checks SQLite integrity and compatibility information.

A standalone CLI is included:

```bash
node dist/v2/cli.js --project /path/to/project doctor
node dist/v2/cli.js --project /path/to/project --session /path/to/session.jsonl sync
node dist/v2/cli.js --project /path/to/project --session /path/to/session.jsonl search PostgreSQL
```

## Development

```bash
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:smoke
pnpm format:check
pnpm benchmark:v2
```

[Engineering notes](docs/V2.md) document the design and limits. [Validation results](docs/VALIDATION-V2.md) distinguish measured behavior from deployment assumptions. The previous engine remains available as `dist/legacy.js` for explicit rollback; its [documentation](docs/LEGACY-README.md) describes v1 behavior.

This is an installable alpha with tested correctness boundaries. A live-provider soak test and platform validation beyond the recorded environment remain release gates for a stable v2.

Remendra is derived from the MIT-licensed Pi Blackhole project. Historical attribution and upstream release history are preserved in the changelog and license.
