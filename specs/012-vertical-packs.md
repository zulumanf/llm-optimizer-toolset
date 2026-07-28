# Spec 012 — Vertical Packs

> Status: draft (ready after 008; informs 009–011)
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
1. `generic-product` (Parva today — works with zero pack-specific machinery)
2. `real-estate-agent` (first agency client)
3. `medical-aesthetics` (surgeons; compliance-heavy — build only with the
   checklist reviewed by a human who owns compliance)
