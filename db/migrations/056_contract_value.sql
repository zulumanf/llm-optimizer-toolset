-- +migrate up
-- Commercial weighting stops proxying value with provider spend (plan 5.7):
-- specs/019 conceded "commercial value = normalised 30-day spend because
-- contract value has no column". Nullable — the operator supplies it per
-- client; absent means the spend proxy continues, honestly.
alter table projects add column contract_value_usd numeric
  check (contract_value_usd is null or contract_value_usd >= 0);

-- +migrate down
alter table projects drop column contract_value_usd;
