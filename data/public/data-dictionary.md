# Data dictionary — v1.0.1

## Common fields (all tables)
| Field | Type | Definition |
|---|---|---|
| `benchmark_id` | string | Release-local id `RF-nnn`, one per run × assistant, in capture order. |
| `market` | string | City and state of the benchmark's prompt pack (e.g. `Greenville, SC`). Wilmington DE and Wilmington NC are distinct markets. |
| `provider` | string | `openai` or `perplexity`. |
| `model_label` | string | Public instrument label: `the OpenAI model (gpt-5.4-mini, web search, API)` or `Perplexity (sonar, API)`. |
| `capture_date` | date | Date of the last answer captured for this benchmark × assistant (UTC). |
| `run_id` | uuid | Platform run identifier (stable; raw answers are immutable). |
| `valid_answers` | integer | Answers with no API error and no refusal, on prompts not held out from scoring. The denominator for every rate. |

## Benchmark summary (`real-estate-ai-visibility-benchmark.csv`)
| Field | Type | Definition |
|---|---|---|
| `run_status` | string | `completed` (every cell succeeded) or `partial` (some calls failed; denominators shrink). |
| `prompt_count` | integer | Frozen prompts in the run's prompt-set version. |
| `recommendation_prompt_count` | integer | Of those, prompts in the `recommendation` category. |
| `repetition_count` | integer | Highest repetition index observed for this assistant (1 = single ask). |
| `captured_calls` | integer | All calls recorded, including failed ones. |
| `answers_with_mention` | integer | Valid answers mentioning at least one tracked entity (recommended or not), echo-excluded. |
| `answers_with_recommendation` | integer | Valid answers recommending at least one tracked entity, echo-excluded. |
| `answers_with_citation` | integer | Valid answers with at least one provider-returned citation. |
| `distinct_entities_recommended` | integer | Number of different entities recommended at least once. |
| `top_entity_recommendations` | integer | Answers recommending the single most-recommended entity. |
| `blocked_pairs` | integer | (response, entity) pairs in this benchmark × assistant whose newest classification needs manual review. They are excluded from every count above and never treated as zero; a non-zero value means the row is provisional until the review queue is cleared. |

## Cited domains (`-domains.csv`)
| Field | Type | Definition |
|---|---|---|
| `source_domain` | string | Registered domain, or a bucket: `agent_or_team_owned_site` (domain owned by a tracked agent/team company) or `single_market_domain` (cited in fewer than 2 market projects across the corpus). |
| `source_domain_is_bucket` | boolean | True for the two buckets. |
| `answers_citing` | integer | Distinct valid answers citing the domain at least once (an answer citing it three times counts once). Not a share of all citations. |

## Anonymized entities (`-entities.csv`)
| Field | Type | Definition |
|---|---|---|
| `entity_label` | string | `E01`, `E02`… per benchmark × assistant, in descending `recommended_in_answers`. Labels are not linkable across benchmarks. |
| `recommended_in_answers` | integer | Distinct valid answers recommending the entity (highest VERIFIED classification revision — human review, explicit verified status, or classifier rows at or above 0.7 confidence; heuristic rows excluded; echo-excluded). |
| `mentioned_in_answers` | integer | Of those recommending answers, how many also carry a mention row (always ≤ recommended). |

## Status vocabulary used in documentation
`named` (a specific agent/team appears), `recommended` (answer says to use them), `mentioned` (appears, not necessarily recommended), `cited` (URL attached by the provider), `retrieved but not cited` (unobservable via API; never counted), `not observed` (zero in a complete run with all aliases searched), `not tested` (no run covers it), `unknown` (partial run or unverified entity).
