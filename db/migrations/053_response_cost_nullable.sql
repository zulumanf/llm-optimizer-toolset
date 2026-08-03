-- +migrate up
-- Evidence-before-cost (production-readiness plan 2.6): a provider call that
-- succeeds but cannot be priced must still capture its raw payload. Recording
-- it as $0 would quietly disable budget caps (the A2 lesson), so unknown cost
-- is now representable as NULL — "unpriced", loudly logged, and the run halts
-- rather than continuing to spend unpriceable calls. The default 0 stays for
-- error rows, which cost nothing by definition.
alter table responses alter column cost_usd drop not null;

-- +migrate down
update responses set cost_usd = 0 where cost_usd is null;
alter table responses alter column cost_usd set not null;
