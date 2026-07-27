# DECISIONS.md — Architecture Decision Log

Append-only. Every non-obvious technical decision gets a dated entry: the decision, the why, and what was rejected. Never edit past entries — supersede them with a new dated entry.

---

## 2026-07-27 — Initial decisions

### Why Postgres?
Experiments are relational to the core: projects → prompt sets → runs → responses → mentions → scores. We need transactions (freezing a prompt set atomically), foreign keys (a score must always trace to a response), and mature JSON support (raw provider payloads in `jsonb`). Rejected: document stores (weak integrity guarantees for an evidence system), SQLite (fine locally, but we need concurrent workers + hosted access).

### Why Next.js (App Router)?
One deployable for UI + API via server actions, first-class TypeScript, and the team already works in React. Internal tool → no need for a separate API service. Rejected: separate SPA + Express API (two deployables, duplicated types), Remix (no team familiarity advantage).

### Why Supabase?
Managed Postgres with auth, row-level security, and storage in one place — minimal ops for an internal tool. We use it as *hosted Postgres first*; features like RLS are additive. Rejected: self-hosted Postgres (ops burden), PlanetScale (MySQL, weaker JSON).

### Why immutable prompt runs and raw responses?
The entire product is an evidence system. If historical data can change, every report becomes unfalsifiable and every trend line untrustworthy. Insert-only raw responses + append-only runs make results reproducible and auditable forever. Cost (storage growth) is trivial next to the value.

### Why version prompt sets (freeze before run)?
Comparing week-over-week scores is only valid if the prompts are identical. Freezing creates an immutable snapshot (`prompt_set_versions`) that runs reference. Editing prompts creates a new version; old runs keep pointing at the version they used.

### Why version scoring methodology?
Weights and equations will evolve. If we silently change them, historical comparisons break. Every computed score row stores `scoring_version`; changing methodology means a new version applied forward (with optional re-scoring stored as *additional* rows, never overwriting).

### Why no microservices?
One team, one internal tool. Microservices buy independent scaling and team isolation — we need neither. They cost deployment complexity, network failure modes, and duplicated logic. A monolith + one worker process covers everything on the roadmap.

### Why a provider abstraction for AI calls (`lib/ai/`)?
We query 4+ providers whose SDKs, auth, and response shapes differ and change. One interface (`runPrompt(provider, model, prompt) → RawResponse`) isolates churn, centralizes retry/rate-limit logic, and makes "add a provider" a one-file change. Rejected: calling vendor SDKs from features (already burned every team that tried).

### Why `specs/` separate from `docs/`?
`docs/` explains why the system exists and how it holds together — stable, read for context. `specs/` are executable work orders — one feature, implemented exactly, then done. Mixing them makes docs churn and specs vague.
