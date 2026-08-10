-- +migrate up
-- Spec 050: the measuring instrument must be recorded, not inferred.
--
-- responses.request_params: the sampling configuration the adapter actually
-- sent. docs/07 promised "temperature/params (provider defaults, recorded)"
-- and nothing recorded them — a run could not be replayed even to the same
-- configuration. Provider defaults are recorded AS "provider_default";
-- explicit values (e.g. Anthropic max_tokens) are recorded as values.
-- Nullable: historical rows predate the record and honestly stay null.
alter table responses add column request_params jsonb;

-- mentions / response_parses classifier stamps: parser_version says the
-- family ("mention-parser-v2+llm") but not WHICH instrument — the classifier
-- model and prompt version could change without any stamp changing, so two
-- v2 mentions months apart could rest on entirely different judgment
-- behavior. Null means the heuristic parser (no LLM instrument involved).
alter table mentions add column classifier_model text;
alter table mentions add column classifier_prompt_version text;
alter table response_parses add column classifier_model text;
alter table response_parses add column classifier_prompt_version text;

-- +migrate down
alter table response_parses drop column classifier_prompt_version;
alter table response_parses drop column classifier_model;
alter table mentions drop column classifier_prompt_version;
alter table mentions drop column classifier_model;
alter table responses drop column request_params;
