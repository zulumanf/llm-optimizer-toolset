# Spec 010 — Content Engine

> Status: draft (ready after 009)
> Depends on: specs/008 (claims) · specs/009 (gaps) · docs/15

## Goal
Turn approved gap-findings into publish-ready assets through a graph of
narrow agents — never "write an article" as one step:

```
gap finding → Opportunity (asset type) → Research (evidence packet)
→ Brief → Draft → Fact-Verification (every claim ↦ claim/evidence id)
→ Compliance (vertical pack rules) → human approval → publish package
```

## Rules
- Drafting agent receives ONLY the brief + evidence packet (approved claims
  by id, cited sources) — the same discipline as the report drafter, whose
  publish-time validator generalizes here: **every factual sentence must
  resolve to a claim id or evidence id**, enforced at the approval gate, not
  by prompt trust.
- Fact-verification runs fresh-context (separate agent version); output is
  counts + per-claim verdicts (verified / unsupported / ambiguous / must-
  remove). Unsupported claims block approval.
- Compliance agent applies the project's vertical pack (specs/012): fair
  housing, medical advertising, unsupported-superiority checks, disclosure
  requirements.
- Publishing itself is red-level: the system produces the final package
  (markdown + schema markup + change list); a human posts it. A published
  asset auto-creates a specs/007 intervention so its effect gets measured.

## Database sketch
`content_opportunities`, `content_assets` (status: opportunity → briefed →
drafted → verified → approved → published), `content_versions` (append-only
body versions with agent/human author + verification report jsonb).

## Acceptance sketch
No path from draft to approved with unverified claims; every published asset
has an intervention; version history immutable; vertical-pack checks recorded
on the approval audit row.
