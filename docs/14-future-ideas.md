# 14 — Future Ideas (Intentionally Postponed)

Everything here is deliberately **not** being built. Ideas land here instead of in code. Promoting an idea requires: a `DECISIONS.md` entry, a spec in `specs/`, and a roadmap slot. Nothing in current architecture should special-case for these.

## Knowledge Graph
Entity graph across responses: companies ↔ sources ↔ claims ↔ topics, revealing *why* providers associate brands with categories ("Parva co-occurs with X in citations from domain Y"). Postponed because: raw tables answer today's questions; a graph without a question is decoration. Revisit when we repeatedly ask relationship questions SQL makes painful.

## Pattern Engine
Automatic detection of recurring structures in answers ("providers always cite review sites for this category", "recommendation sets are stable triads"). Postponed until we have months of data — pattern mining on thin data manufactures noise.

## Agent
An agent that reads findings and autonomously investigates ("recommendation rate dropped on Gemini — figure out why"). Postponed: conflicts with "software suggests, humans approve" until the measurement substrate is fully trustworthy. The immutable data model is agent-ready by design.

## PR Automation
Findings → automatically drafted content changes / PRs to Parva's site or docs. Postponed: highest-risk loop closure; requires mature attribution (spec 007) proving which changes matter before automating them.

## Browser Automation
Driving consumer AI UIs (ChatGPT web, Gemini app) to capture answers the APIs don't represent (memory, web-mode, consumer defaults). Valuable — consumer surfaces are what buyers actually see — but operationally fragile (bot detection, ToS constraints, selector churn). Revisit only if API-vs-consumer divergence proves material; must comply with each service's terms.

## Customer SaaS
Selling this as a product. Explicit non-goal (`docs/00-vision.md`): multi-tenancy, billing, and support would consume the roadmap. The internal moat (methodology + longitudinal data) matters more. Reconsider only after Parva itself demonstrably benefits for 6+ months.

## Smaller parked items
- **Statistical inference v2:** confidence intervals / hypothesis tests for change detection (first in line — see roadmap).
- **Prompt coverage advisor:** suggest un-measured query categories from category research.
- **Source intelligence dashboard:** which external domains drive citations; outreach targets.
- **Digest emails / Slack alerts:** weekly deltas pushed instead of pulled; alert on failed baselines.
- **Multi-language prompt sets:** measure non-English answers (schema already has `language`).
- **Response diffing:** side-by-side comparison of the same prompt's answers across runs.
- **External task sync:** push approved tasks to Linear/GitHub Issues.
- **Public methodology page:** publish our scoring methodology as authority-building content (meta: the tool marketing itself).
