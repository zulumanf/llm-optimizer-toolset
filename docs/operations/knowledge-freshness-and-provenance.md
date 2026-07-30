# Knowledge Freshness & Provenance — Operations

> 2026-07-29 · Companion to `specs/020`–`specs/024`. Operational counterpart to
> `docs/operations/automation-safety-and-autonomy.md`.

## Freshness states

Every claim resolves to exactly one state. There is no "probably fine".

| State | Meaning | May enter a high-risk packet |
|---|---|---|
| `current` | inside its review window | yes |
| `nearing_review` | within 20% of the window's end | yes, flagged |
| `stale` | past its review window, no successor | **no** — excluded and disclosed |
| `expired` | time-bounded and its period has ended (a 2024 ranking in 2026) | **no** |
| `superseded` | a newer approved version exists | no — the successor is used |
| `unknown` | no effective date, or never verified | **no** — treated as unusable |

`unknown` is deliberately not optimistic. A sales-volume figure with no "as of"
date cannot be stated as current, so the platform will not let an agent try.

## Review windows

Named constants in `lib/knowledge/constants.ts` — no magic numbers.

| Category | Window | Why |
|---|---|---|
| `affiliation`, `team` | 90 days | brokerage and team changes happen without notice, and stating an old one is a reputational error |
| `ranking`, `award` | its stated year, then `expired` | a 2024 ranking is true *about 2024*; restating it as current is the classic overclaim |
| `transaction` | stable once `verified`; `unknown` while unverified | a closed sale does not decay |
| `market_statistic` | 90 days, must carry a period | a market number without its period is meaningless |
| `inventory` | 7 days | listings move |
| `sales_volume` | 180 days, **must** carry an as-of date | the single most-litigated figure in this domain |
| default | 365 days | |

## What the operator sees

- **Claim review** — every claim's state as a badge; `stale` and `expired` sorted first.
- **Wiki page** — the page's state is the **worst** of its dependencies, so one
  expired ranking makes the whole page read as expired rather than hiding inside it.
- **Packet inspector** — per item, and in `missingContext` when exclusion
  happened for freshness reasons.
- **Open risks hot file** — expired claims and open contradictions, compiled.

## Provenance: what is recorded, and where

Provenance lives in tables (`wiki_section_provenance`, `context_packet_items`),
never inside a Markdown body. Front-matter would be unqueryable, hand-editable
and duplicated across every rendering.

Each material wiki section records:

```
section_id            the section it describes
claim_ids             claims used
claim_version_ids     the exact versions, so history stays reproducible
evidence_ids          supporting evidence
instruction_version_ids  rules applied when phrasing it
source_artifact_ids   original material behind the evidence
compiled_at           when
compiler_version      by which compiler
```

Clicking a section in the UI shows exactly that: claims used, evidence used,
source quality, effective dates, contradictions, compiler version.

Each packet item records what it is, why it was selected (a named deterministic
rule, or a retrieval score), its token cost, its freshness, its privacy class —
and the same for everything **excluded**, with the reason. Exclusions are data,
not silence.

## Reproducibility

Three chains must resolve for a past decision to be explicable:

1. **Packet** → `content_hash` → the exact claims, evidence, instructions and
   sections the agent saw.
2. **Page version** → immutable body + provenance → the canonical records it was
   compiled from.
3. **Claim version** → immutable → the evidence and effective dates at the time.

None of the three can be edited. Together they answer "why did the platform say
that, in March?" without anyone reconstructing it from memory.

## Runbook

**A page is stale and not rebuilding.** Check `knowledge_build_items` for a
`failed` row and its error; the page stays stale by design until a build
succeeds. Re-run the build for that page; if it fails its attempt budget, a
knowledge exception is raised.

**A packet is missing a fact the operator expects.** Open the packet inspector.
The fact is either (a) not an approved claim, (b) excluded by privacy for that
audience — it will be in the withheld list, (c) excluded by freshness — it will
be in `missingContext`, or (d) dropped by budget — it will be an item with
`included = false` and an exclusion reason. One of the four is always true;
there is no silent path.

**A contradiction appears.** It is a flag, not an instruction. Resolve it by
approving a new claim version with correct effective dates, or by dismissing it
with a recorded reason. **Never** by deleting the older claim.

**A source turns out to be wrong.** Ingest the corrected source (it supersedes
the old artifact), propose corrected claims, approve them, let the affected
pages rebuild. The wrong source stays stored — that is what makes the correction
auditable.

**Everything looks stale after a deploy.** Check whether a compiler or template
version changed. A version bump changes content hashes, so the first build after
it legitimately rewrites pages. The second build should be all no-ops; if it is
not, a template is non-deterministic and that is a bug.
