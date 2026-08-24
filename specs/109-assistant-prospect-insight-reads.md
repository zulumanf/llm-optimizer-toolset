# Spec 109 — Assistant Prospect Insight Reads (diagnose, timeline, intent, upcoming)

> Status: ready
> Depends on: specs/096, specs/098, specs/107
> Branch: feat/109-assistant-prospect-insight-reads

## Goal

Four read functions the cockpit already computes are invisible to chat:
the prospect diagnosis, the per-prospect activity timeline, the derived
intent, and the upcoming-automation view. Four read-tier wrappers close
the gap — the operator can ask "why is this prospect stuck?", "what
happened with X?", "how warm is X?", and "what sends are queued next?"
without leaving the conversation.

## API (assistant tools)

| Tool | Tier | Input (zod) | Backing call |
|---|---|---|---|
| `diagnose_prospect` | read | `{ prospect_id: uuid }` | `diagnoseProspect` (`lib/prospects/diagnose.ts:316`) |
| `prospect_timeline` | read | `{ prospect_id: uuid, limit?: int 1–50 = 25 }` | `prospectTimeline` (`lib/prospects/dashboard.ts:349`), newest-first slice |
| `prospect_intent` | read | `{ prospect_id: uuid }` | `prospectIntent` (`:333`) — null reports "no intent derivable", never a guess |
| `upcoming_automation` | read | `{ launch_id?: uuid }` | `upcomingAutomation` (`:292`) |

All group `prospecting`. Pure reads; no gates, no migration.

## Edge cases

- Unknown prospect ids surface the services' own null/empty results —
  the model says "not found / nothing recorded", never invents history.
- Timeline is sliced newest-first to the limit (transcript budget);
  the count of omitted older events is reported.

## Acceptance criteria

- [ ] Four read tools grouped and cataloged (existing unit tests
      enforce); timeline slices with an omitted count.
- [ ] Loop round trip for timeline + intent on a seeded prospect
      (integration).
- [ ] Lint, typecheck, full suite pass.

## Definition of done

Criteria pass · tests green · lint/typecheck clean · docs/05 updated.
