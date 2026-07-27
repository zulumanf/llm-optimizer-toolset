# 11 — Coding Standards

Extends the rules in `CLAUDE.md`. When in doubt: match the surrounding code; if there is no surrounding code, this file decides.

## Naming
- Files: kebab-case (`prompt-set-actions.ts`), React components PascalCase files (`RunProgressCard.tsx`).
- Variables/functions: camelCase, descriptive over short (`frozenPromptCount`, not `cnt`). Booleans read as predicates (`isFrozen`, `hasEvidence`, `needsReview`).
- Types/interfaces: PascalCase, no `I` prefix. Zod schemas: `xxxSchema`; inferred types: `type Xxx = z.infer<typeof xxxSchema>`.
- Constants: `SCREAMING_SNAKE_CASE` in `lib/constants.ts` or module-local.
- Database: snake_case (see `docs/03`); the query layer maps to camelCase at the boundary.

## Folder structure & imports
- Dependency direction: `app/ → components/ → lib/ → db/`. Never the reverse; `lib/` imports nothing from `app/` or `components/`.
- Path aliases: `@/lib/...`, `@/components/...`, `@/db/...` — no `../../..` chains.
- Import order (eslint-enforced): node builtins → external → aliases → relative. No default exports except Next.js pages/layouts (framework requirement).
- One module = one concern. A file over ~300 lines is a smell; split by responsibility, not by line count.

## Functions
- Small, single-purpose; if a function's name needs "and", split it.
- Business logic functions are pure where possible: data in → data out; side effects (DB, network) live at the edges (`db/`, `lib/ai/`).
- No boolean flag parameters that change behavior (`doThing(true)`) — two named functions or an options object with named fields.
- Explicit return types on all exported functions.

## React & hooks
- Server components by default; `"use client"` only for interactivity, as low in the tree as possible.
- Components render; they do not compute business logic or touch the DB (`CLAUDE.md`). Data arrives via props from server components/actions.
- Custom hooks in `components/hooks/`, prefixed `use`, one behavior each.
- No `useEffect` for data fetching — server components or actions handle data.

## Error handling
- The query layer and `lib/ai/` throw typed errors (`ClassifiedError` with `kind`: `provider_rate_limit`, `provider_auth`, `validation`, `not_found`, `conflict`, `internal`).
- Server actions catch at the boundary and return a discriminated union: `{ ok: true, data } | { ok: false, error: { kind, message } }`. UI switches on `ok` — no thrown errors crossing the wire.
- Never swallow: every `catch` either handles meaningfully, rethrows with context, or records to the log **and** surfaces to the user. Empty catch blocks are forbidden.
- Worker jobs: failures recorded on the job row with the classified error; retryable kinds retry with backoff, terminal kinds fail fast and alert.

## Logging
- Structured JSON via one logger module (`lib/logger.ts`): `level`, `event`, `entityId`s, no free-form string interpolation of objects.
- Log events, not narration: `run.cell.failed`, not "something went wrong in the loop".
- Never log secrets, auth headers, or full raw payloads (payloads are in the DB; log the `response_id`).

## Validation
- Zod at every trust boundary: server action inputs, cron payloads, provider responses (shape validation in adapters), env vars (validated once at startup in `lib/env.ts` — the app refuses to boot with missing config).
- Parse, don't check: validated data flows onward as its inferred type; raw `unknown` never travels past the boundary.

## Comments & documentation
- Comments state invariants and non-obvious *why* ("insert-only: trigger blocks UPDATE, see docs/03"), never *what* the next line does.
- Every module in `lib/scoring/` and `lib/parsing/` opens with a doc comment linking the governing doc (`docs/06`, `docs/12`) and the version it implements.
- Public utilities get JSDoc with one example. No changelog comments — git history does that.

## Misc
- No `any`, no non-null `!` assertions (narrow instead), no `enum` (use union types / `as const` maps).
- Dates: store timestamptz UTC; format only at render. Use `date-fns`, not hand-rolled math.
- Money: `numeric` in DB, integer micro-dollars or `Big.js` in code for accumulation — never float addition for `cost_usd`.
- Formatting: Prettier defaults, enforced in CI. Zero-warning ESLint policy.
