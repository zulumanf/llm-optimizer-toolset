-- +migrate up
-- Spec 054: shared market captures. Twenty same-city clients asked the
-- provider the same market question twenty times; the answer is a fact
-- about the market, not about any client. A cell can now be satisfied by
-- copying a recent original capture of the byte-identical prompt from a
-- DIFFERENT project — full payload, cost 0, provenance in reused_from.
-- Same-project runs always sample fresh (a retest must never "measure"
-- its own baseline).
alter table responses add column reused_from uuid references responses(id);

-- Eligibility lookup: newest original captures of one (prompt, provider,
-- model). md5 keeps the index small; the query re-checks byte equality.
create index responses_reuse_idx
  on responses (md5(prompt_text), provider, model, requested_at desc)
  where error is null and reused_from is null;

-- Per-run opt-out: an operator can force fresh sampling.
alter table runs add column reuse_captures boolean not null default true;

-- +migrate down
alter table runs drop column reuse_captures;
drop index responses_reuse_idx;
alter table responses drop column reused_from;
