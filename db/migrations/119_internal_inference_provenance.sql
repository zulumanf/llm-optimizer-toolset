-- +migrate up
-- Spec 142: distinguish the backend that performed internal inference.
--
-- Existing rows remain NULL because their backend cannot be reconstructed
-- safely from the model string alone. New runAgent calls record it.
--
-- Local Ollama calls have zero external API spend, but are not invisible:
-- model, backend, tokens, attempts, success, and duration are recorded.
alter table llm_calls
  add column backend text,
  add column duration_ms bigint;

alter table llm_calls
  add constraint llm_calls_duration_ms_nonnegative
  check (duration_ms is null or duration_ms >= 0);

-- +migrate down
alter table llm_calls
  drop constraint if exists llm_calls_duration_ms_nonnegative;

alter table llm_calls
  drop column if exists duration_ms,
  drop column if exists backend;
