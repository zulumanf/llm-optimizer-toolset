# Intervention and remeasurement protocol

Purpose: record what was changed, for whom, when, and what moved afterwards — without ever turning "moved after" into "moved because".

## What the platform records (existing + spec 141 additions)
| Need | Where |
|---|---|
| Intervention type | `interventions.intervention_type` (migration 081) |
| Changed URL | `interventions.changed_url` (migration 115, new) |
| Change description | `interventions.change_description` (115, new); `description`, `hypothesis` existed |
| Implementation date | `interventions.shipped_at` |
| Control entity | `interventions.control_company_id` (115, new): a tracked competitor or unrelated entity that received no change |
| Held-out prompts | `prompt_set_versions.frozen_prompts[].isHoldout`; held-out prompts never enter scores and are the untouched comparison set |
| Baseline result | `intervention_runs` with `role = baseline` (existing), on the frozen prompt-set version |
| Post-change result | `intervention_runs` with follow-up roles and `offset_label` (existing) |
| Follow-up dates | `intervention_runs` rows per follow-up; engagement remeasurement rules (`lib/engagements/rules.ts`) |
| Citation/recommendation movement | `citation_map_targets.citation_change_after_placement` (115, new) for placements; `compareMeasurements` for engagements |
| Comparability | instrument change ⇒ "not comparable" (`lib/engagements/rules.ts`) |

## Protocol
1. **Freeze before you touch.** A baseline run on the frozen prompt-set version must exist within 14 days before the change, on the same instruments that will be used afterwards.
2. **Declare the change once.** One intervention row per discrete change: type, URL, description, date, and the hypothesis it tests.
3. **Name a control.** Record a control entity (same market, no change) and rely on the held-out prompts as the untouched question set.
4. **Remeasure on schedule.** Follow-ups at fixed offsets (the engagement rules default to mid-term and end-of-term); each follow-up is a new run, never an edit.
5. **Report movement, not cause.** The report states baseline and follow-up counts with denominators for the subject, the control and the held-out prompts, and the instrument on each date. Allowed wording: "recommended in 3 of 256 at baseline, 9 of 256 at week 6; control 2 → 2". Disallowed: "the article caused", "because of the change", "ranking improved".
6. **Comparability gate.** If the model build, repetition count, prompt-set version or provider differs between the two runs, the pair is reported as not comparable; no movement is stated.
7. **Placement movement.** For citation-map targets, `recordCitationMapRemeasurement` stores before/after answers-citing and client-recommended counts with both run ids and a `comparable` flag; the target reaches `remeasured` only through that call.
8. **Sample floor.** No movement is stated when either side has fewer than 6 valid answers on the relevant prompts (`MIN_STABLE_SAMPLE`).

## What would allow a causal statement
Only a designed experiment: randomized or matched-market assignment, pre-registered hypothesis, held-out prompts, a control entity, identical instruments on both dates, and an effect larger than the run-to-run variation observed in repeated baselines. Until such an experiment exists, every report uses movement language.
