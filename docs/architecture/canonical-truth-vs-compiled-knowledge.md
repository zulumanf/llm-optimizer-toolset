# Canonical Truth vs Compiled Knowledge

> 2026-07-29 · Companion to `specs/020` and `specs/023`.

One distinction, stated once, because confusing the two is how a knowledge
system quietly starts lying.

## The distinction

| | Canonical truth | Compiled knowledge |
|---|---|---|
| What it is | what the platform is allowed to believe | a rendering of that belief |
| Where it lives | `claims`, `claim_versions`, `knowledge_entities`, `entity_relationships`, `claim_contradictions`, `knowledge_instruction_versions` | `wiki_pages`, `wiki_page_versions`, `wiki_sections` |
| Who writes it | humans approving, services under policy | the compiler, and nothing else |
| Can an agent change it | it may **propose**; approval of a material claim is human | it cannot; it only reads |
| Can a human edit it directly | yes, through the approval path | no — generated sections are not editable |
| If deleted | catastrophic | rebuild and lose nothing |
| Versioning | immutable claim versions | immutable page versions |

## The rule

> A compiled page is never evidence of anything except what the compiler
> produced from canonical records at a point in time.

If a page says "JC Luxury closed $180M in 2025", that sentence is not a fact.
It is a rendering of `claim_0182` at version 3, compiled by `wiki-compiler-v1`
on a given date, and the section's provenance row names exactly that. Change the
claim and the sentence changes. Edit the sentence and nothing changes, because
there is no code path from the page to the claim.

## How the separation is enforced

Not by documentation. By four structural facts:

1. **`wiki_page_versions` carries `forbid_mutation()`.** Postgres refuses an
   UPDATE or DELETE on a page version. The same trigger already protects
   `responses`, `claim_versions`, `evidence_packets` and `domain_events`.
2. **The compiler is the only writer**, and it selects exclusively from
   canonical tables. It has no input channel from the UI.
3. **The wiki UI has no mutation path to `claims`.** Generated sections render
   read-only. Human annotations are separate, labelled, owned records.
4. **Agents hold no transaction handle** (spec 018). An agent returns a
   `NodeResult`; the engine writes. This is why an agent cannot approve a
   material claim regardless of what its prompt says.

## Proposing a change

The only route from "someone thinks this is wrong" to "the platform believes
something different":

```
agent or human proposes a change
→ identify affected canonical objects
→ attach evidence
→ detect contradictions
→ verify (independent verifier for material claims)
→ request human approval where policy requires it
→ create a new canonical version (the old one stays readable)
→ mark affected pages stale
→ compile new page versions
→ validate
→ activate
→ prior page versions remain reproducible
```

An annotation on a page can *enter* this flow. It cannot bypass it.

## Materiality

Not every claim needs the full path. Materiality decides:

**High-risk** (strong evidence, freshness validation, contradiction check,
independent verification, human approval): sales volume · rankings · "best" /
"top" / "leading" claims · brokerage affiliation · team leadership · transaction
attribution · celebrity-client relationships · confidential transactions ·
awards · licensing · market dominance · revenue outcomes.

**Ordinary** (evidence + approval): markets served, specialties, service
descriptions, neighbourhood coverage.

For every claim the platform stores its approved wording, qualified wording,
prohibited wording, required date language, required disclaimers, privacy
limitations, permitted workflows and permitted public use. The packet carries
those constraints to the agent verbatim, which is why a drafting agent has no
room to invent phrasing.

## History is preserved, not corrected

A superseded claim is not deleted and not hidden. It keeps its effective dates,
so a report generated three months ago remains explicable: its packet hash
resolves, its claim versions resolve, and the page versions it cited are still
readable. Contradiction detection flags disagreement for a human; it never
resolves one by deleting the older side.
