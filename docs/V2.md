# V2 engineering notes

## Architecture

`index.ts` exports `src/v2/extension.ts`. The built host entry is small and uses public Pi 0.85.1 APIs. `legacy.ts` preserves the original 0.4.10 entry; it is not loaded by default.

The host reads Pi's existing active-branch entries and ingests newly encountered immutable IDs. It does not rescan session files on every context request. Source conversion excludes chain-of-thought and binary attachments. Tool calls and results remain in Pi's original order; the context hook only inserts one custom memory message at the front and removes older Remendra packets.

Storage, FTS5 search, source rendering, imports, and backups run in a worker with a 256 MiB old-generation limit. RPCs have deadlines; a failed worker rejects all outstanding callers and restarts on the next operation. SQLite provides cross-process write serialization. WAL plus `synchronous=FULL` protects committed writes; jobs left behind by a crash expire and become eligible again.

There is one database per configured memory home. Every record carries project and session identity. This differs from the blueprint's separate project database proposal: a shared database makes cross-scope dependency invalidation and budget reservations atomic. Scope filters remain mandatory, including during vector retrieval. SQLite files are private local application data, not a multitenant server security boundary.

## Memory model

Claims are typed, versioned assertions with source hashes and UTF-16 spans into stored, redacted text. States are `candidate`, `active`, `disputed`, `stale`, `superseded`, and `retracted`. Similar text is not merged. Stable observer IDs make repeated identical extraction idempotent. Separate episodes remain separate evidence.

`source_checked` verifies provenance: the exact span exists in an available source. It does not establish truth or logical entailment. Assistant-only assertions and branch summaries become hypotheses. Imported memories become candidates. A user's explicit command can accept a candidate; such acceptance is a user decision, not independent factual verification.

Mutually exclusive values can be detected when claims provide matching `subject` and `predicate` keys. Overlapping incompatible values are disputed rather than resolved by recency. This is structured conflict detection, not universal natural-language contradiction detection.

Corrections are a single transaction: retire the old claim, retain its revision history, register retired evidence spans, invalidate dependent conclusions transitively, and write the replacement. An observer citing a retired span produces a stale record, so paraphrasing an old source cannot revive it. Updates use expected revisions to reject concurrent stale edits.

Retrieval checks current status, branch visibility, valid-time interval, environment, source availability, and the revision of every dependency. Historical `asOf` lookup selects the latest recorded revision available at that time and uses the claim's valid interval. History is subject to present-day erasure and visibility rules; it is not a way to restore deleted information.

## Context and native compaction

The compiler combines active anchors with query-relevant lexical results. Pinned memories rank first. Each selected JSON record includes its evidence and eligibility explanation. The compiler measures the full rendered output, including warnings and omission counts; records are never truncated to make them fit.

The counter is `ceil(UTF-8 bytes / 3)`. It is an explicit heuristic, not an exact model tokenizer. The host also reduces the budget based on Pi's reported context usage and an output reserve. If the mandatory provenance header cannot fit, the packet is omitted. If storage fails, normal Pi messages continue unchanged and the previous Remendra packet is removed.

Pi owns compaction timing, compaction summaries, overflow recovery, and tool pairing. V2 records a memory manifest after successful native compaction. It does not patch `AgentSession`, inspect function source, capture provider streams, or replace native model retries. The optional `checkpoint` command previews memory-only content for inspection; incomplete coverage makes that preview invalid.

Native Pi summaries have their own provenance limits and may contain historical assertions. Current Remendra packets explicitly identify superseded or disputed memory IDs; V2 does not claim to semantically rewrite every old assertion in an arbitrary native summary.

## Background extraction

Sources are divided into bounded ranges with states `pending`, `leased`, `processed`, `excluded`, or `damaged`. Coverage is a set of ranges, never a single token cursor. A successful empty result marks a chunk processed; a failed or cancelled attempt leaves it pending. Claims and completed coverage commit together.

The observer receives source excerpts as untrusted data. It returns structured JSON with exact quotes. The parser resolves quotes to stored offsets itself and rejects missing, ambiguous, or out-of-batch citations. The observer cannot pin, erase, promote scope, or assert user authority.

Work runs after Pi's `agent_settled` event. Foreground start, branch changes, and shutdown cancel it. A generation check prevents late results from attaching to another session. Providers that ignore cancellation are raced against an abort signal, so they cannot hold the UI open or commit late results.

At most four batches run per settled turn. Each batch gets at most two attempts by default, with configured model fallback through `ctx.modelRegistry.complete`. Remaining chunks remain visible in `gaps`; `/remendra learn` resumes eligible work. Failed final attempts have a 30-second retry delay. This version does not run an independent always-on daemon or idle timer.

Budget reservations are transactional and shared across projects/processes. They include estimated input plus maximum output before dispatch. Successful calls use provider-reported token usage. Missing usage after cancellation, error, or process death consumes the full reservation. A provider can exceed an estimate; the cap is a dispatch guard, not an exact invoice cap. Price totals are provider-reported estimates, and unknown-price calls remain separately counted.

## Procedures

A procedure starts as a candidate. Users can attach a tool result through `/remendra trial`:

```text
/remendra trial {"procedureId":"MEMORY_ID","expectedRevision":1,"sourceKey":"SOURCE_KEY","outcome":"success","environment":"node24-linux","note":"The documented build completed successfully."}
```

The source must be a tool result in the active lineage, and its error flag must match the reported outcome. Duplicate evidence hashes cannot count twice. Two successful trials in the same environment allow retrieval only in that environment. A failure revokes eligibility and requires two new successes after that failure. This is user-reviewed outcome tracking; it does not automatically prove that an arbitrary tool result executed every step of a procedure.

## Semantic search

The optional adapter accepts an explicit OpenAI-compatible embedding endpoint. It validates vector count, indexes, dimensions, and finite values, rejects redirects, limits responses to 4 MiB, and times out requests. Vector keys include endpoint/model configuration; a memory revision change deletes its cached vector.

Indexing and semantic queries are explicit commands, share the token reservation ledger, and keep ordinary context compilation local. Similarity ranks candidates; every hit still passes the same visibility and validity checks as lexical retrieval. The cosine scan is capped at 10,000 vectors. This is suitable for a bounded local collection, not a claim of large-scale ANN performance.

## Privacy and erasure

Built-in redaction covers common API tokens, credential assignments, private-key blocks, terminal escape sequences, and control bytes. Configured redaction patterns are literal strings, avoiding regex denial-of-service. Sensitive tool paths are excluded before routine ingestion. These filters are useful controls, not a complete secret detector.

`erase` scrubs source payloads and historical claim payloads, removes dependent claims and vectors, and records tombstones that block ordinary re-ingestion and re-import. Erasing shared evidence can remove more than one memory; the command reports how many. SQLite secure deletion is enabled, but this is logical application erasure, not a guarantee of forensic removal from SSDs, snapshots, or filesystem backups.

Original Pi session files, old exports, and backups are separate. Explicit `#N`, file, regex, and touched-file recall reads original sessions and labels this fact in the response. Such reads can still expose text erased from v2; users seeking complete removal must manage the original files too. Raw transcript reads are limited to 64 MiB and a worker deadline. Indexed source recall remains available for larger collections already ingested.

User memory is opt-in through `includeUser`. A project directory maps to a generated UUID, not an inferred identity from its name or Git remote. Linking a moved directory to an existing project is an explicit user action.

## Import and restore

V1 migration visits observation/reflection arrays directly, including custom entries and folded details. It preserves content distinctions and old aliases without invoking legacy fuzzy deduplication. V2 JSONL export includes claims, referenced sources, revision events, and project-scoped erasure tombstones. Merge import creates candidate claims with remapped evidence; it does not replay authoritative event history or restore old dependency authority.

For exact recovery, use a `VACUUM INTO` backup. Stop all processes using this memory home, preserve the existing database and its `-wal`/`-shm` files together in a separate recovery directory, then copy the consistent backup to `memory.sqlite`. Start Pi and run `/remendra doctor`. Do not place old WAL/SHM files beside a replacement database. Encrypted disks and backup policy belong to the host system; V2 does not embed an encryption key manager.

## Current bounds and release scope

Tested target: Pi 0.85.1 and Node 24 on Linux. The Bun SQLite adapter is present but has not been validated as a complete Pi runtime. Windows/macOS and live provider behavior need separate soak tests before a stable release.

Memory and historical candidate windows are bounded, so extremely broad searches can omit matches. Normal lexical candidate collection is capped at 600 rows, historical scans at 2,000 revisions, anchor collection at 300, and returned hits at 200. Source exports/imports and raw transcript browsing have explicit size bounds. The system makes omission and pending coverage visible; it does not claim perfect recall.

This alpha implements the memory substrate, user controls, lifecycle integration, optional semantic adapter, migration, and validation harness. A dashboard, automatic project-wide session discovery, background semantic indexing, a separate reflector model, provider-specific exact tokenizers, and a long-running retention/maintenance daemon are not included. They should be added only with tests and measured benefit; they are not hidden placeholders behind enabled settings.
