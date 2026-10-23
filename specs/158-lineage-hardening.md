# Spec 158 — Lineage hardening before 142–147 reach main

> Status: implemented locally (2026-10-21) on `feat/158-lineage-hardening`. Not pushed, merged or deployed.
> Base: `hotfix/156b-outreach-safety` (main + 156 + 148/150 subset) + the remaining `ca48d67` lineage (142, lead-contract commits, 145B–E, 146, 147) cherry-picked with `-x`.
> Audience: operator (internal); no client-facing change.

## Why

The lineage review (2026-10-21) found the code sound, and found contractual measurement untouched. It also found four reasons it was not safe to merge:

1. **147 starts by itself.** Every worker tick queues weekly third-party fetches and Ollama inference for every live client, dispatches Gmail drafts and reconciles. There is no switch to turn this off.
2. **`safeFetch` lets private addresses through.** IPv4-mapped IPv6 in the parser's hex form passes `isPrivateHost`, so `http://[::ffff:169.254.169.254]/` reaches the metadata endpoint. Several reserved IPv4 ranges are also missing. This bug is already on `main`; 147 makes it run unattended.
3. **Ollama calls have no timeout, and nothing stops a remote server being called unauthenticated.**
4. **Nothing proves contractual measurement can never route to Ollama.** It is true today only because the classifier calls `modelForTask` directly.

There are also process gaps: unbounded draft retries, a deploy-order trap with migration 119, and five commits with no spec.

## Changes

### H1 — Profile corrections are opt-in (`PROFILE_CORRECTIONS_ENABLED`)

Profile corrections run only when `PROFILE_CORRECTIONS_ENABLED === "true"`. The default (unset) is **off**, and every check uses the same helper, `profileCorrectionsEnabled()`.

When off:

- **Weekly scheduling:** `runWeeklyKick` does not queue checks; it reports `profileChecks: { skipped: "disabled" }`.
- **Tick sweeps:** `runAutomationTick` skips the profile-check dispatcher, the correction-draft dispatcher and reconciliation, and reports `skipped: "disabled"`.
- **Queued jobs:** `profile_check_dispatch` and `profile_correction_draft_dispatch` complete without doing work. They log `profile_corrections.disabled` and are not re-enqueued.
- **Starting checks:** `startProfileChecks` refuses, for both operator and schedule origins, with `conflict: Profile corrections are disabled…`. The authorization gate still runs first.

Unaffected: decisions on approvals that already exist (`applyCorrectionDecision` stays database-only), existing data, and reads.

### H2 — Automatic draft retries are capped

- `PROFILE_DRAFT_MAX_AUTO_ATTEMPTS = 3`.
- `readyForDrafting` excludes any request that already has 3 or more `failed` attempts.
- An operator can re-arm a capped request through `retryProfileCorrectionDraft`. That action now accepts a `failed` attempt **only when the request has reached the cap**. The operator's reason and identity are recorded, and the failed attempt is superseded, never deleted. This is the same mechanism and the same audit trail as an uncertain-outcome retry.

### H3 — `safeFetch` classifies addresses, not strings

`isPrivateHost` parses IP literals:

- **IPv6:** fully expanded, including `::` compression, zone ids and embedded dotted quads.
- **IPv4:** dotted quad.

**Refused IPv4:**

| Range | What it is |
|---|---|
| 0.0.0.0/8 | "this network" |
| 10.0.0.0/8 | private |
| 100.64.0.0/10 | CGNAT |
| 127.0.0.0/8 | loopback |
| 169.254.0.0/16 | link-local, cloud metadata |
| 172.16.0.0/12 | private |
| 192.0.0.0/24 | IETF protocol assignments |
| 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 | documentation |
| 192.168.0.0/16 | private |
| 198.18.0.0/15 | benchmarking |
| 224.0.0.0/4 | multicast |
| 240.0.0.0/4 | reserved, including 255.255.255.255 |

**Refused IPv6:**

| Range | What it is |
|---|---|
| `::`, `::1` | unspecified, loopback |
| ::ffff:0:0/96 | IPv4-mapped, judged as its IPv4 address, **in any notation** |
| ::/96 | IPv4-compatible, judged as IPv4 |
| 64:ff9b::/96 | NAT64, judged as its embedded IPv4 |
| 2002::/16 | 6to4, judged as its embedded IPv4 |
| fc00::/7 | unique local |
| fe80::/10 | link-local |
| fec0::/10 | site-local |
| ff00::/8 | multicast |
| 2001:db8::/32 | documentation |
| 2001::/32 | Teredo |

**Hostnames:** `localhost`, `*.localhost` and `*.internal` are refused, including with a trailing dot. Hostnames are no longer judged by text prefix, which used to refuse public names such as `fd.example.com`.

DNS-resolved addresses go through the same classifier. The resolve-then-connect race (DNS rebinding) is still documented and not solved; pinning the connect address needs a dispatcher dependency and stays out of scope.

### H4 — Ollama: timeout and remote authentication

- **Timeout:** every `/api/chat` request carries `AbortSignal.timeout(OLLAMA_REQUEST_TIMEOUT_MS)`, set to 280,000 ms (below the 300 s node timeout of the slowest route). A timeout raises `ClassifiedError("internal")`, so the request fails closed and the engine never races a still-running request.
- **Remote authentication:** `ollamaRequestHeaders` is taken verbatim from release 151. A non-loopback `OLLAMA_URL` must be https **and** have an `OLLAMA_API_KEY`, which is sent as a bearer token; otherwise the call is refused. A key is never sent over plain http.

### H5 — Contractual measurement can never route to Ollama

New test, `tests/unit/measurement-provider-boundary.test.ts`. It fails if any of the following happens:

- a measurement task (`mention_classification`, `mention_verification`, `accuracy_analysis`) appears in `INTERNAL_TASK_TARGETS`, or `inferenceTargetForTask` returns a non-OpenAI backend for it;
- any module under `lib/parsing`, `lib/runs` or `lib/scoring`, or the measurement capture providers (`lib/ai/{openai,anthropic,google,perplexity,registry}.ts`), imports the internal-inference registry, the Ollama backend or `inferenceTargetForTask`;
- `INTERNAL_TASK_TARGETS` changes without this test being updated, because an exact list is pinned.

### H6 — Deploy order for migration 119

`docs/deployment.md` gains a **"Migrations before code"** rule. The worker image applies migrations on boot. A web-only deploy of code that needs a newer migration must be preceded by `scripts/migrate.ts up` against the production database. The same rule is written down for this lineage: 119–125.

`recordLlmCall` already logs `llm_ledger.write_failed` at error level, so a missed migration shows up in logs, not as silence. The runbook names that event.

### H7 — Retroactive record for the commits that had no spec

These lineage commits shipped without a spec. Their behaviour is recorded here so that future changes have something to reference. No behaviour changes in this section.

| Commit | What it does |
|---|---|
| `a436d26` — inbound lead contract | `det.normalize_lead`; `lead.created` gains defaulted fields; `lead.created` and `lead.qualified` no longer require a project. Webhook triggers stay disabled until a secret is set. |
| `6da47c1` — deterministic qualification | `classify_lead` (OpenAI, prompt `classify-lead-v2`) returns signals only. The score is `det.calculate_lead_qualification`: weights 30/25/20/15/10, threshold 60, unknown signals score 0. |
| `2184d65` — support triage on Ollama | `summarize_support_request` runs on `qwen3:8b` (prompt v3) with `message` and `knowledge` context. Auto-response produces a Gmail **draft** only. There is no deterministic category allow-list yet (recorded as a follow-up). |
| `ca6fa2c` — claim extraction on Ollama | `knowledge_claim_extraction` runs on `gpt-oss:20b` (prompt v3) with a strict category enum and guards against non-factual wording. Claims still enter as `proposed`. |
| `2e0dbe5` — navigation | Adds a sidebar and command-palette entry for `/prospects/dashboard`. The page is staff-gated (spec 156). |

## Out of scope (recorded)

- DNS-rebinding pinning.
- Retrying a transport-level Ollama failure. It stays `failed_terminal`, which is fail-closed.
- A support auto-reply category allow-list.
- Provisioning a production Ollama host. That is an **operator decision**: with no host, the four Ollama tasks fail closed.
- Severity from model confidence (146 N4).
- Spec D (measurement/outreach isolation).

## Acceptance criteria

- [x] **Flag unset:** no weekly queueing (`runWeeklyKick` returns `profileChecks: { skipped: "disabled" }`), no tick sweeps, job handlers are no-ops, and `startProfileChecks` refuses with `conflict` after the authorization gate (a client still gets `forbidden`). With the flag `"true"`, behaviour is unchanged: the six existing 147 suites, 85 tests, pass with it set. Removing the job-handler gate makes the new test fail (checked by mutation).
- [x] **Retry cap:** automatic drafting stops after 3 failed attempts, even well past the back-off window. A manual retry below the cap is refused. A manual retry of a capped attempt supersedes it and records the operator, the reason and `retry_of`.
- [x] **Address classes:** `isPrivateHost` refuses every listed range in every notation (73 cases), including `[::ffff:169.254.169.254]` after URL normalisation, decimal and hex IPv4, trailing-dot `localhost.`, and NAT64 and 6to4 embeddings. It accepts public addresses and public names such as `fd.example.com`. `assertPublicUrl` applies the same classifier to resolved addresses.
- [x] **Ollama:** every request carries an abort signal (280 s). A timeout fails closed with a clear message. A remote `OLLAMA_URL` over http, or with no key, is refused before any request. Connection failure, non-JSON responses, HTTP errors and empty output all fail closed (9 unit tests; the caller previously had no tests).
- [x] **Measurement boundary:** the test passes, and fails both when `mention_classification` is added to the Ollama routes and when the parser imports the internal router (checked by mutation).
- [x] **Full validation:**

  | Check | Result |
  |---|---|
  | Typecheck, lint | Clean |
  | Unit + integration | 287 of 287 files, 3,292 of 3,292 tests (including the 156 page and action authorization suites) |
  | Production build | Passes |
  | Read sweep (client, production build) | 0 of 137 leaking; own portal intact |
  | Playwright (isolated database) | 76 of 76 |
  | Migrations | Fresh apply, rollback 125 → 119 and re-apply, and upgrade of a populated 118 database all pass |
