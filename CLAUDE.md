# CLAUDE.md — How to Think in This Repository

This file tells Claude Code how to think. It is not documentation — it is operating instructions.

---

## Mission

This repository is the **AI Visibility OS — the internal operating system used to grow clients through AI visibility experiments**.

We measure how AI assistants (ChatGPT, Claude, Gemini, Perplexity, etc.) mention, describe, and recommend each client versus its competitors. We run controlled, versioned prompt experiments; capture raw responses immutably; score them with transparent, versioned methodology; and turn findings into evidence-backed tasks.

- **Not SaaS.** No billing, no plans, no marketing pages.
- **Not multi-tenant.** One team, internal only.
- **Internal only.** Optimize for operator effectiveness, not polish for strangers.

## Never Figure Out — Implement

Claude Code should never be "figuring out" what to build. Product decisions live in `docs/`. Executable feature specs live in `specs/`. If a request has no spec, the first deliverable is a spec, not code.

Workflow: **read the spec → implement exactly → all acceptance criteria, tests, lint, and typecheck pass → stop.** Do not begin another spec until the current one is done.

If a request conflicts with `PRINCIPLES.md`, the principles win. Say so and stop.

---

## Core Philosophy

Never optimize for "ranking." Always optimize for:

- **Evidence** — every claim traceable to a raw response or source
- **Authority** — genuine usefulness and expertise, not tricks
- **Usefulness** — features that change a decision, not vanity dashboards
- **Measurement** — if it isn't measured and reproducible, it didn't happen

---

## Architecture Rules

- Never introduce microservices. One Next.js app + Supabase + background workers.
- Never create duplicate business logic. One implementation, imported everywhere.
- Use server actions for mutations; route handlers only for webhooks/cron.
- Prefer composition over inheritance and over configuration flags.
- Business logic stays in `lib/` — never inside React components.
- Never put database logic inside React components. Data access lives in `db/`.
- Always create migrations for schema changes. Never mutate the schema by hand.
- All AI provider calls go through the provider abstraction in `lib/ai/`. Never call a vendor SDK directly from a feature.

## Coding Rules

- Strict TypeScript. `strict: true`, no `any`, no `@ts-ignore`, no `@ts-expect-error` without a linked issue.
- No ignored lint errors. Fix or justify in the PR — never suppress silently.
- No duplicated functions. Search `lib/` before writing a utility.
- No magic numbers — named constants in `lib/constants.ts` or the relevant module.
- No hardcoded strings for anything semantic (statuses, model names, prompt text). Enums, constants, or `docs/13-prompts.md`-managed templates.
- Full details: `docs/11-coding-standards.md`.

## UI Rules

- Tailwind only. shadcn/ui components. No inline styles, no CSS files per component.
- Dark mode supported from day one. Desktop-first (internal tool).
- Accessible: keyboard navigation, labels, focus states, sufficient contrast.
- Every async view has loading, empty, and error states. No spinners without context.
- Full details: `docs/04-ui-design-system.md`.

## Database Rules

- **Never delete experiment data.** Soft-delete or archive; raw data is sacred.
- **Raw responses are immutable.** Insert-only. No UPDATE, no DELETE, ever.
- **Never overwrite historical prompt runs.** Re-running creates a new run.
- **Everything is versioned.** Prompt sets, scoring methodology, parsers.
- Full schema: `docs/03-database-schema.md`.

## AI Rules

- Never fabricate results. A failed run is recorded as failed, not filled in.
- Always preserve raw responses before any parsing or scoring.
- Never modify historical measurements — new scoring versions re-score forward, old scores stay.
- Always attach and explain confidence. Low-confidence parses go to human review.
- Full details: `docs/12-ai-guidelines.md`.

## Testing Rules

- Every scoring function has unit tests with known-answer fixtures.
- Every parser has tests against real captured responses (snapshots).
- Every migration is reversible and tested both directions.
- Full details: `docs/09-testing-strategy.md`.

## Git Rules

- Small commits, one logical change each.
- Feature branches named `feat/<spec-number>-<slug>`, e.g. `feat/003-experiment-runs`.
- Meaningful commit messages: what changed and why, referencing the spec.
- No direct commits to `main`.

---

## Where Things Live

| Question | File |
|---|---|
| Why does this exist? | `docs/00-vision.md` |
| What are we building? | `docs/01-product-prd.md` |
| How is it structured? | `docs/02-system-architecture.md` |
| What's the schema? | `docs/03-database-schema.md` |
| How should UI look? | `docs/04-ui-design-system.md` |
| How does feature X behave? | `docs/05-feature-specifications.md` + `specs/` |
| How are scores computed? | `docs/06-scoring-methodology.md` |
| How do experiments run? | `docs/07-experiment-protocol.md` |
| What's next? | `docs/08-roadmap.md` |
| How do we test? | `docs/09-testing-strategy.md` |
| Security posture? | `docs/10-security.md` |
| Code style details? | `docs/11-coding-standards.md` |
| AI feature rules? | `docs/12-ai-guidelines.md` |
| Prompt templates? | `docs/13-prompts.md` — never hardcode prompts elsewhere |
| Postponed ideas? | `docs/14-future-ideas.md` |
| How does work get executed? | `docs/architecture/graph-native-platform-architecture.md` + `specs/018` |
| What may run without a human? | `docs/architecture/automation-quality-operating-model.md` |
| How is the portfolio managed? | `specs/019` |
| Why did we decide X? | `DECISIONS.md` |
| Unbreakable rules? | `PRINCIPLES.md` |

When you make a non-obvious technical decision, append it to `DECISIONS.md` dated, with the why.
