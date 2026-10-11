# Changelog

## [2.3.0] - 2026-10-11

Closes the gaps left in 2.2.0, each measured against the real Qwen 3.x and embeddinggemma setup it was found on.

### Fixed

- **Embedding never blocks memory.** The worker ran calls one at a time, so an embedding request waiting on a cold server held up packet compilation and ingestion behind it, and a prompt arriving then got "memory temporarily unavailable". Embedding now runs beside the queue.
- **Cold or flaky embedding servers.** Ollama's embedding runner, sharing a GPU with a chat model, crashed and reloaded on the first requests (HTTP 400 "do embedding request: … EOF", 13–18 s a try). Requests are retried and split, every finished vector is kept even when time runs out, and deadlines fit the context: 120 s in the background, 90 s for `/remendra embed`, 20 s for a recall query (then keywords). Verified live: a cold `/remendra embed` stored all vectors in 12 s.
- **No extra request for a second look.** 2.2.0 asked the model again at once when it found nothing in user text. Now user text that no memory cites rides along with the next batch, which is sent anyway; alone it waits up to an hour.
- **Paraphrased duplicates.** The observer sees existing memories related to each batch and marks claims that only repeat one. A marked claim is dropped only if every name, number and relation word (not, before, after, only…) in it already appears in that memory; an unmarked one only if all its words do. Restatements were blocked in 15 of 15 valid runs and changed values kept in 8 of 8. The cost: with the list in view the model returns new facts in about 83% of single calls instead of about 93%; the second look covers the rest.
- **Search cues stayed out of memory text.** The model had started copying cue words into the stored text.

### Changed

- **Recall ranks by meaning.** With an embedding endpoint, the recall tool ranks memories by similarity, with matching words as a small bonus, instead of using keywords with a semantic fallback. On 46 questions (36 paraphrases, 10 exact names) the right memory came first for 42–45, against 38–39 before; all 46 were in the top three.
- **Search cues.** The observer writes 4–8 cues per memory (category, synonyms, the question it answers). They are indexed for keyword search and embedded with the memory. Memories without cues, such as `/remendra remember` text and everything learned before this version, get them in the background, one small request per 24.
- **Embedding prefixes.** embeddinggemma, nomic-embed and e5 models get the task prefixes they were trained with; `queryPrefix` and `documentPrefix` set them for other models. Old vectors are rebuilt automatically.

## [2.2.0] - 2026-10-11

From a live end-to-end run against Pi 1.1 and a local Qwen model, with a logging proxy recording every model request.

### Fixed

- **Memories reach other sessions.** Learned memories start in the session that learned them and are promoted to the project when it ends. Only sessions with two or more prompts were promoted, and a session that never ended cleanly (closed terminal, crash, WSL shutdown) never was: one real database had 50 memories no other session could see. One prompt is now enough, and at startup Remendra promotes what sessions without a clean shutdown left behind, once they have been quiet for an hour.
- **Local models lose fewer memories.** With Qwen 3.x, learning lost facts in four ways, all fixed:
  - Thinking took 10–125 s per batch and ran into the job timeout. Observer requests now turn thinking off (`reasoning_effort: "none"` on OpenAI-compatible endpoints); `observerThinking: true` turns it back on.
  - The prompt said to skip "prompt instructions", so "Note: we use Redis. Reply OK only." often produced nothing. It now says to keep the facts and ignore the request. On Qwen, 14 of 15 such batches were extracted, up from 7 of 11.
  - An empty answer for text the user wrote is asked once more before the text counts as done.
  - JSON wrapped in prose, or left in the model's thinking, is found. The thinking fallback read a field Pi does not use, so it had never worked.
- **Recall no longer creates duplicates.** The recall tool's output was learned like any other tool result, so each recall stored the memories it showed a second time. It is not a learning source any more (output queued by older versions is dropped on upgrade), and the observer skips a claim whose text matches a memory already visible.
- **Explicit memories are learned once.** Text saved with `/remendra remember` or `correct` was also sent to the observer.
- **`/remendra erase` removes earlier revisions.** Erasing a corrected memory left the versions before the correction, and their sources, on disk.
- **Hidden messages leave no copy.** When a Pi context edit removes or rewrites a message, its old text is deleted unless a memory cites it.
- **Private keys are always redacted.** A key cut off before its END line (truncated tool output) was stored and sent to the observer as is, and many unclosed key markers made redaction quadratic (1.6 s for 600 KB). Redaction is now one linear pass and also catches JSON-escaped and single-line keys.
- **Chinese, Japanese and Korean token estimates.** chars/4 counted them at about half their real size (measured on Qwen), so packets in those scripts overran their budget. Han, kana and Hangul characters now count three times.
- **Recall tool arguments from small models.** Values such as `mode: "claims"` or `scope: "project"` failed validation (10 of 42 calls in one history) and are now mapped to the valid ones.
- **`/remendra embed` works with a cold server.** Its 10 s timeout was shorter than an Ollama model load (12–13 s). It is 45 s now.
- **Cancelled learning is not a failure.** A prompt or compaction arriving during learning counted toward the "learning degraded" warning.
- **Status line.** It kept showing "learning" after cancelled learning or `index-sessions`, and did not show the mode after `/remendra settings`.
- Failed observer attempts, and batches that produced no memories, are written to `remendra.log`.

### Changed

- **The recall tool falls back to semantic search** when no memory matches the words and an embedding endpoint is configured. New memories are embedded in the background after learning. Before, vectors were only used by `/remendra semantic`.
- **An unchanged packet stays in place.** When the next prompt selects the same memories, the packet stays where it was instead of moving to the new prompt, so the turn in between keeps its prompt cache.
- **Smaller recall results.** The recall tool returns the packet's compact records instead of full JSON with internal ids and hashes: about 320 characters per memory instead of 750.
- **`/remendra search` and `history` are readable:** one memory per entry, id first.
- **`/remendra-recall /pattern/`** searches the transcript with a regular expression.
- **Recall mode is documented as it behaves:** no packet and no learning; memory only through the recall tool.

## [2.1.0] - 2026-10-10

Bug-fix release for Pi 1.1, from an audit of a real installation (66% of background jobs failing, crashes on exit).

### Fixed

- **Pi no longer crashes when background learning is cancelled.** If a cancellation (new prompt, `/tree`, compaction, quitting) landed while a job was being leased, the model call started with an already-aborted signal and its rejection was never observed, so Node terminated Pi ("Session, branch, or memory changed", "Native compaction has priority").
- **Cancelled jobs no longer drain the daily budget.** A job cancelled before the call was sent costs nothing; one cancelled mid-call costs its input estimate, not the full 8,400-token reservation.
- **Search finds memories for natural questions.** The whole query was matched as one exact phrase, so "where do we deploy the api?" found nothing and context packets fell back to anchors only. Queries now match any meaningful term (stop words removed), ranked by bm25; short queries filter by substring; `asOf` history applies the query.
- **A stuck storage worker restarts** instead of making every later memory call time out until Pi restarts.
- **`/remendra index-sessions` reads real Pi session files** (it parsed a format Pi does not write and indexed nothing), and only indexes sessions of the current project.
- **Search index corruption** ("database disk image is malformed") when erasing a memory whose source had been replaced.
- **Observer output:** more than 16 claims or one malformed claim no longer discards the whole batch.
- **Excluded paths** also apply to tool arguments such as `bash` commands (`cat .env`).
- **Regex recall** is used only in `regex` mode or for `/pattern/` queries; questions containing `?` or `.` are word searches.
- Pi 1.x `system` entries no longer appear as empty assistant rows in recall.
- `peerDependencies` use `"*"` (Pi provides its own packages).

### Changed

- **The memory packet is placed right before the latest prompt** instead of at the front of the conversation, so the provider's prompt cache keeps everything earlier. Local models no longer re-read the whole conversation on every prompt.
- **Pi context edits are respected:** a message you remove or rewrite stops feeding memory.
- **No background learning in `pi -p` / JSON runs**, which exit as soon as the agent settles; their sources are learned in the next interactive session or with `/remendra learn`.
- **Untrusted projects say why nothing is learned** (status line and `/remendra learn`).
- **Diagnostics go to `remendra.log`**, never the terminal, where they drew over Pi's screen. `/remendra doctor` shows the path.
- Developed and tested against Pi 1.1.0.

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
