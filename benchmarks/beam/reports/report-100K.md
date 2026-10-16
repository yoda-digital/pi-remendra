# BEAM 100K on Remendra

Chats 20, questions 400. Observer claude-haiku-5-5, answers claude-sonnet-5-5, judge claude-sonnet-5-5. Packet budget 2400 tokens, recall budget 6000.

## Judge score (%) by ability

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

## Evidence in context

Share of questions with labelled evidence where at least one / every evidence message is cited by the context.

| Condition | any evidence | all evidence | mean context tokens | mean retrieval ms |
|---|---:|---:|---:|---:|
| none | 0.0 | 0.0 | 0 | 0.0 |
| bm25 | 69.3 | 33.8 | 8301 | 7.4 |
| packet | 69.9 | 33.8 | 2340 | 29.2 |
| recall | 76.1 | 40.0 | 6182 | 40.7 |

## Learning

Source tokens 3060186, observer calls 1403, observer tokens 12811731, observer cost $4.29, memories 6543, deferred runs 70.
