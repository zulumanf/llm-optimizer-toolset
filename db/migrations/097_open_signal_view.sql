-- +migrate up
-- Spec 125: read-time open classification. Raw open rows are immutable
-- evidence (migration 087); this view is the interpretation layer. A
-- "signal open" is any class other than 'scanner'. Heuristic version:
-- open-signal-v1 (lib/prospects/constants.ts).
create view outreach_open_signal as
select o.id, o.send_id, o.opened_at, o.ip, o.user_agent,
  case
    when o.user_agent is null or o.user_agent = 'Mozilla/5.0' then 'scanner'
    when o.user_agent like '%GoogleImageProxy%' or o.user_agent like '%ggpht%' then 'proxy'
    else 'browser'
  end as signal_class
from outreach_email_opens o;

-- +migrate down
drop view outreach_open_signal;
