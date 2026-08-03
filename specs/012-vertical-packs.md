# Spec 012 — Vertical Packs

> Status: done (2026-07-29)
>
> **Live: a full real-estate client onboarded in 0.1s — 33 generated
> prompts, approved claim, 2 competitors, pinned pack** (previously an
> hour of hand-written setup per client). Three packs ship:
> `generic-product`, `real-estate-agent`, `medical-aesthetics`.
>
> Implementation notes: pack definitions live in TS
> (`lib/verticals/packs.ts`) as the reviewable source of truth; a project
> **pins a jsonb snapshot** (`vertical_packs` row) so editing a pack never
> mutates a live client — the same immutability philosophy as frozen prompt
> versions. Expansion is deterministic and capped at 40 prompts, ordered by
> intent tier so high-intent prompts survive the cap; templates whose
> variables the operator left blank are skipped entirely rather than
> emitting `{placeholder}` text. Onboarding deliberately does NOT freeze the
> set or start a run — the benchmark is the instrument, and a human reviews
> it first (docs/07). Compliance rules are now enforced: `validateContent`
> takes the project's pinned pack rules, and "block" severity fails the
> content gate (fair-housing and guaranteed-outcome for real estate; PHI,
> outcome guarantees, and superiority claims for medical aesthetics).
> Depends on: specs/008 · docs/15

## Goal
Make industries configuration, not code forks. A vertical pack bundles what
changes between a luxury realtor, a plastic surgeon, and a SaaS product; a
project selects exactly one pack.

## A pack defines
- **Prompt category templates** with tiered intent (the blueprint's Tier 1–4):
  e.g. real estate: client-type / need-state / cross-market / property-type /
  neighborhood / broad / branded / comparison; medical aesthetics: procedure /
  concern / credential / locality / safety / branded / comparison. Templates
  contain variables ({market}, {neighborhood}, {procedure}) filled from the
  client knowledge base to generate candidate prompts (human approves + freezes,
  as always).
- **Entity vocabulary**: what a "transaction"-equivalent is (closing, procedure
  volume, case study), which claim keys are standard for the vertical.
- **Compliance checklist** consumed by specs/010's compliance agent:
  real estate → fair-housing language, brokerage naming, unverifiable
  superiority claims; medical → advertising regulations, before/after and
  testimonial rules, patient privacy (no PHI ever enters the system), required
  disclaimers; generic → substantiation of superlatives.
- **Ranking/authority machinery** hooks for specs/011 (e.g., RealTrends/TRD
  eligibility engines exist only inside the real-estate pack).
- **Newsworthiness heuristics** for story detection.

## Shape
Packs are versioned data (jsonb seed + docs), not branches: `vertical_packs`
(key, version, definition jsonb), `projects.vertical_pack_id`. Editing a pack
creates a new version; projects pin one (same philosophy as prompt freezing).

## First packs
1. `generic-product` (the original pilot client — works with zero pack-specific machinery)
2. `real-estate-agent` (first agency client)
3. `medical-aesthetics` (surgeons; compliance-heavy — build only with the
   checklist reviewed by a human who owns compliance)
