# BEAM on Remendra

[BEAM](https://github.com/mohammadtavakoli78/BEAM) ("Beyond a Million Tokens", arXiv:2510.27246) asks 20 probing questions per long conversation, covering ten memory abilities, and scores answers with an LLM judge per rubric item (0, 0.5, 1).

`beam.ts` ingests each BEAM chat into its own Remendra store as one session, runs the production `BackgroundLearner` with `OBSERVER_PROMPT` until every chunk is read, and answers each question with BEAM's `answer_generation_for_rag` prompt from one of four contexts:

- `none`: no memory (floor)
- `bm25`: BM25 over user/assistant pairs, budget = packet + recall (8 400 tokens)
- `packet`: the packet Remendra injects before the prompt (2 400 tokens)
- `recall`: packet plus one `recall` call in source mode with the question as query

Answers are scored with BEAM's `unified_llm_judge_base_prompt`. Event ordering is reported with the judge score only (BEAM also computes Kendall tau with LLM alignment).

```bash
git clone --depth 1 https://github.com/mohammadtavakoli78/BEAM.git /path/to/BEAM
node benchmarks/beam/run.mjs --beam /path/to/BEAM --size 100K --concurrency 20
```

LLM calls go through `claude -p` by default; set `BEAM_OPENAI_URL` (and `BEAM_OPENAI_KEY`) to use an OpenAI-compatible endpoint. Models: `--observer-model`, `--answer-model`, `--judge-model`. Every call is cached under `--out`, so a run resumes where it stopped.

## Results: 100K split (20 chats, 400 questions)

Observer claude-haiku-5-5, answers and judge claude-sonnet-5-5. Full report: [reports/report-100K.md](reports/report-100K.md); per-question rows with answers and judge reasons: [reports/rows-100K.json](reports/rows-100K.json).

| Ability | none | bm25 | packet | recall |
|---|---:|---:|---:|---:|
| abstention | 100.0 | 77.5 | 81.3 | 72.5 |
| contradiction_resolution | 0.0 | 52.8 | 46.3 | 59.1 |
| event_ordering | 0.0 | 27.1 | 29.2 | 31.2 |
| information_extraction | 0.0 | 73.7 | 50.4 | 78.6 |
| instruction_following | 1.3 | 46.9 | 31.9 | 50.0 |
| knowledge_update | 0.0 | 56.9 | 45.6 | 59.4 |
| multi_session_reasoning | 0.0 | 54.9 | 35.3 | 56.8 |
| preference_following | 0.0 | 74.8 | 63.1 | 81.9 |
| summarization | 0.0 | 28.9 | 13.6 | 22.7 |
| temporal_reasoning | 0.0 | 47.5 | 43.1 | 53.8 |
| **mean of abilities** | **10.1** | **54.1** | **44.0** | **56.6** |

Learning read 3.06M source tokens with 1 403 observer calls ($4.29), producing 6 543 memories; 10 646 of 10 650 chunks were processed.

## Limitations

- The default daily learning budget (80 000 tokens) would read about half of one 100K chat per day; the harness lifts it to 10M.
- One observer claim with an invalid validity interval fails its whole batch (76 times in this run, 70 batches deferred after both attempts); the chunks were retried later.
- Embeddings were off (no endpoint), so ranking is FTS5 only.
- Two questions per ability per chat: per-ability scores over 20 chats carry roughly ±10 points of noise.
- Scores are not comparable with the paper's tables, which use other answer and judge models.
