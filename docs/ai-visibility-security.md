# AI Visibility Intelligence — Security

> Canonical security doc: `docs/10-security.md`. This file covers (1) the threat model of the new MCP layer and (2) the security findings of the 2026-08-01 audit (`docs/ai-visibility-system-audit.md` §H) with owners for remediation.

## MCP layer threat model

| Threat | Control |
|---|---|
| Unauthorized use of the tool surface | Staff-only actor resolved at startup (`MCP_USER_ID` → active `users` row); refusal to boot otherwise; per-invocation re-check in `invokeTool` (defense in depth). Client roles have no surface. |
| Privilege escalation via tools | No bespoke role logic in MCP; every mutation passes the services' own `assertCanWrite` and validation. Read tools call the same readers the UI uses. |
| External action through an agent | Structurally impossible: no publish/send/connector tools exist. The approval boundary (`workflow_approvals`, autonomy ≤2 ⇒ human approval, 7-check send gate) is not reachable from MCP except read-only (`list_pending_approvals`). Approval decisions are UI-only. |
| Prompt injection via tool output | Tool outputs are data read from the DB (largely AI-answer derived). The consuming agent must treat them as data; on the platform side, captured responses are never fed into tool-calling contexts (`docs/12-ai-guidelines.md`) and `lib/ai/agent.ts` remains tool-free. |
| Malicious tool descriptions | Descriptions are static strings in `lib/mcp/tools.ts`, code-reviewed; no dynamic description assembly. |
| Runaway spend | `run_prompt_set` inherits the hard budget cap (checked pre-spend, micro-USD), pricing-required-to-run validation, per-provider rate gates, and quota short-circuit. No tool can raise a budget. |
| Replay / duplicate execution | Optional idempotency keys with an append-only ledger; concurrent duplicates surface as an explicit conflict, never a silent second run. |
| Secret exposure | The server reads `.env` like the worker does; no tool returns configuration; logs go through `lib/logger.ts` (no secrets by convention); stdout is protocol-only, logs on stderr. |
| Tampering with the invocation record | `mcp_invocations` is insert-only (`forbid_mutation` trigger), FK-attributed to a real user. |

Out of scope by design (documented limitations): the stdio server trusts its local operator (it is not a network service); there is no per-tool permission tiering among staff roles beyond the platform's own gates.

## Audit findings and remediation track (pre-existing platform issues)

Ranked in `docs/ai-visibility-system-audit.md` §H. Items 1–2 were fixed 2026-08-01 on `fix/visibility-audit-phase-1`; the rest remain on the pilot-launch track (`docs/pilot-launch-plan.md`):

1. **SSRF redirect bypass** — **fixed**: `lib/security/safe-fetch.ts` is now the single outbound-fetch policy (manual per-hop revalidation, DNS resolution check, streaming size caps); used by ingestion, crawling, and robots fetches. Residual: resolve-then-connect TOCTOU race, documented in-module.
2. **Prompt-injection fencing** on crawled content — **fixed**: `buildExtractionPrompt` carries the "data, not instructions" framing and neutralizes embedded fence markers.
3. **Mock provider reachable in production** (known P0 A1) — fabricated answers can reach real scores when no keys are configured.
4. No security headers/CSP in `next.config.ts`; hand-rolled `escapeHtml` in export paths.
5. `audit_log` covers ~7 of 22 write domains; MCP's ledger closes this only for MCP-originated mutations.
6. Supabase superuser password rotation (long-standing operator blocker).
