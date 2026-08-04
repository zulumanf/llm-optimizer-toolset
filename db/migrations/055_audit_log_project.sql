-- +migrate up
-- The audit log is the only complete record of who did what, and it could
-- not answer "for which client" — flagged in July, unfixed since
-- (production-readiness plan 4.4). Nullable on purpose: platform-level
-- actions (user admin, connector setup) have no client. Backfill below is
-- best-effort by entity join; rows that cannot be resolved stay null and
-- the timeline says so rather than guessing.
alter table audit_log add column project_id uuid references projects(id);
create index audit_log_project_idx on audit_log (project_id, at desc)
  where project_id is not null;

-- The backfill must drop the insert-only shield for its own labeling pass
-- (the scripts/seed-graph.ts precedent): it annotates rows with ownership,
-- it never touches recorded facts. Re-armed immediately below. Caught on a
-- live database — an empty test DB never fires the row trigger.
alter table audit_log disable trigger audit_log_immutable;

update audit_log a set project_id = t.project_id
  from tasks t where a.entity = 'task' and a.entity_id = t.id;
update audit_log a set project_id = r.project_id
  from runs r where a.entity = 'run' and a.entity_id = r.id;
update audit_log a set project_id = r.project_id
  from reports r where a.entity = 'report' and a.entity_id = r.id;
update audit_log a set project_id = i.project_id
  from interventions i where a.entity = 'intervention' and a.entity_id = i.id;
update audit_log a set project_id = s.project_id
  from prompt_sets s where a.entity = 'prompt_set' and a.entity_id = s.id;
update audit_log a set project_id = c.project_id
  from content_assets c where a.entity = 'content_asset' and a.entity_id = c.id;
update audit_log a set project_id = c.project_id
  from campaigns c where a.entity = 'campaign' and a.entity_id = c.id;
update audit_log a set project_id = p.project_id
  from program_plans p where a.entity = 'program_plan' and a.entity_id = p.id;
update audit_log a set project_id = g.project_id
  from gap_findings g where a.entity = 'gap_finding' and a.entity_id = g.id;
update audit_log a set project_id = f.project_id
  from accuracy_findings f where a.entity = 'accuracy_finding' and a.entity_id = f.id;
update audit_log a set project_id = w.project_id
  from workflow_runs w where a.entity = 'workflow_run' and a.entity_id = w.id;
update audit_log a set project_id = p.id
  from projects p where a.entity = 'project' and a.entity_id = p.id;

alter table audit_log enable trigger audit_log_immutable;

-- Future rows resolve themselves: one central mapping instead of touching
-- ~150 writeAudit call sites. An explicit projectId from the writer wins;
-- unknown entities stay null (honest, never guessed).
create function audit_log_resolve_project() returns trigger
language plpgsql as $$
begin
  if new.project_id is not null or new.entity_id is null then return new; end if;
  new.project_id := case new.entity
    when 'task' then (select project_id from tasks where id = new.entity_id)
    when 'run' then (select project_id from runs where id = new.entity_id)
    when 'report' then (select project_id from reports where id = new.entity_id)
    when 'intervention' then (select project_id from interventions where id = new.entity_id)
    when 'prompt_set' then (select project_id from prompt_sets where id = new.entity_id)
    when 'prompt' then (select s.project_id from prompts p join prompt_sets s on s.id = p.prompt_set_id where p.id = new.entity_id)
    when 'content_asset' then (select project_id from content_assets where id = new.entity_id)
    when 'campaign' then (select project_id from campaigns where id = new.entity_id)
    when 'program_plan' then (select project_id from program_plans where id = new.entity_id)
    when 'gap_finding' then (select project_id from gap_findings where id = new.entity_id)
    when 'accuracy_finding' then (select project_id from accuracy_findings where id = new.entity_id)
    when 'workflow_run' then (select project_id from workflow_runs where id = new.entity_id)
    when 'claim' then (select project_id from claims where id = new.entity_id)
    when 'competitor' then (select project_id from competitors where id = new.entity_id)
    when 'project' then (select id from projects where id = new.entity_id)
    else null
  end;
  return new;
end;
$$;

create trigger audit_log_project_resolve
  before insert on audit_log
  for each row execute function audit_log_resolve_project();

-- +migrate down
drop trigger audit_log_project_resolve on audit_log;
drop function audit_log_resolve_project();
drop index audit_log_project_idx;
alter table audit_log drop column project_id;
