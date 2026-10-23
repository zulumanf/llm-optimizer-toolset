# Spec 145C — Profile Correction Live Input

> **Status:** implemented (2026-09-23); re-verified 2026-10-02 (full unit suite including `profile-correction-live-input`; the `automation-layer`, `workflow-engine` and `workflow-e2e` integration suites pass on the local test database).
>
> **Scope:** make a real `profile.error_detected` run of `reputation_profile_correction_v1` reach Spec 145B canonical extraction. Two input-wiring defects only.

## Problem

Spec 145B wired `fetch_profile → canonical_extract → approved_facts → compare`, but a real event-started run never gets that far. Tracing the live path shows **two** defects, not one:

| Step | What actually happens today |
|---|---|
| 1. `lib/events/bus.ts:208-221` | Starts the run with `input = { event: { id, type, version, correlationId, occurredAt }, payload }`. `payload` is validated by `lib/events/catalog.ts` `profileError`: `{ profileType, profileUrl, findingId?, severity }`. No `trigger` block. |
| 2. `entry` — `trigger("entry", "schedule", …)` → `trg.schedule` | `triggerNode("schedule")` (`lib/automation/nodes/human.ts:159-199`) computes `observed = declared.kind ?? (event.id ? "domain_event" : "unknown")` = `"domain_event"`, which ≠ `"schedule"`, and returns **`failed_terminal`**: *"this graph declares a schedule entry point but the run was started by "domain_event""*. **The run stops here.** |
| 3. `fetch_profile` — `fetch(…, { inputPath: "payload" })` → `int.cms_fetch_public_page` | If step 2 passed, `payloadFor` (`lib/automation/nodes/integration.ts:29-40`) would resolve `payload` (from the entry output or run input) and send `{ profileType, profileUrl, findingId, severity }` to `executeCapability`. |
| 4. `cms.fetch_public_page` (WordPress, `lib/connectors/adapters/business.ts:317-331`) | `requireString(input, "url", …)` fails — there is no `url`. The node fails; `failureStrategy: "continue"` passes `{ ok: false }` on. |
| 5. `canonical_extract` (Spec 145B) | Safe-stops: *"the profile fetch did not succeed"*. |

Root causes:
1. The entry node declares a `schedule` entry point, but the only trigger that carries a profile is the `profile.error_detected` domain event.
2. The event payload names the field `profileUrl`; the capability's input contract names it `url`, and no step maps one to the other.

## Decision

- **Entry kind.** Change the entry node to `trigger("entry", "domain_event", "Profile error detected")`. The event is the only start that carries a profile URL. A scheduled run has no profile to fetch, so it could not reach canonical extraction under either entry kind. After this change it fails at `entry` with the existing explicit mismatch message, instead of calling a connector with no URL. The `schedule` trigger declaration is left as it is. Deciding where a weekly scan gets its profile URLs is deferred (see Non-Goals).
- **Field mapping lives on the node, not in the connector or the event.** Add an opt-in `inputFields` config to integration nodes: an object of `capability input field → dotted path`, resolved with the existing `resolve()` (so the lookup order and "read, never permission" rule stay the same). `fetch_profile` becomes:

  ```ts
  fetch("fetch_profile", "cms.fetch_public_page", "Fetch the profile", {
    inputFields: { url: "payload.profileUrl" },
  }),
  ```

  `inputPath: "payload"` is removed, so the connector receives exactly `{ url }` and nothing from the event payload that it doesn't need.
- Rejected alternatives:
  - Accepting `profileUrl` in the WordPress adapter would change a shared connector contract (content live-verification and competitor intelligence both use it).
  - Renaming the event field would break the trigger schema and `idempotencyTemplate: "profile:{{payload.profileUrl}}"`.
  - A new mapping node would add a graph node where a config option is enough.
  - `det.map_fields` is DB-backed per-client mapping for imports, which is the wrong tool here.

## Required Behavior

### `inputFields` (`lib/automation/nodes/integration.ts` `payloadFor`)
- `inputFields` and `inputPath` are mutually exclusive. Two sources for one payload is ambiguous, so the combination is rejected both at definition validation and at run time (`failed_terminal`, connector not called). `config.params` remain defaults under either.
- A mapped path that resolves to `undefined` or `null` **omits** the field. It never sends `""`, `"undefined"`, or a value taken from anywhere else, so the connector's own required-field check reports the gap.
- `inputFields` must be a plain object of non-empty strings. Otherwise the node fails terminally with a clear error rather than sending a partial payload.
- Nodes that do not set `inputFields` build exactly the same payload as today. `payloadFor` is the single payload builder for every integration node, including the guarded send, publish and invoice nodes. Their inputs are unchanged because none of them set `inputFields`.

### Path validation (`lib/automation/runtime.ts` `validateNodePaths`)
- Validate `inputFields` like `contextPaths`: it must be an object of non-empty dotted paths, and each root that is a node key must be an ancestor. `inputFields` combined with `inputPath` is a validation error.

### Preserved
- **Event and trigger schemas:** the `profile.error_detected` payload schema, trigger declarations and `idempotencyTemplate` are unchanged.
- **Tenant scope:** the run's `projectId` still comes from `event.projectId`, and `executeCapability` still receives `ctx.projectId`. `inputFields` can't set scope.
- **Provenance:** `fetch_profile.data.url` is the mapped `profileUrl`. `canonical_extract` ingests that URL (Spec 145B, unchanged). The trigger output still carries `eventId` and `correlationId`.
- **Test mode:** connector fixtures are keyed by capability, not input, so behavior is unchanged. `canonical_extract` still safe-stops in test mode.
- **Spec 145B:** `canonical_extract`, `compare` `contextPaths`, and every downstream node are unchanged.
- **Other workflows:** no other definition changes. `archive_before_after` still reads `fetch_profile.data`.

### Live-run precondition (not changed here)
`executeCapability` needs an active connection for a provider that implements `cms.fetch_public_page`. Today that is WordPress, or `manual`, which expects an operator-supplied `payload` and so will not work with `{ url }`. With no WordPress connection, `fetch_profile` records `no_connection` and `canonical_extract` safe-stops. That is correct behavior, and it is documented here so a missing connection isn't mistaken for this defect.

## Non-Goals
- Where the weekly `profile_scan` schedule gets its profile URLs, or whether that trigger should remain.
- Accepting several entry kinds in one trigger node.
- A connector for fetching third-party public pages without a CMS connection.
- `subjectAllowList`, cross-artifact duplicate claims, the `detect_contradictions` migration, onboarding, model routing, measurement providers.

## Tests

New `tests/unit/profile-correction-live-input.test.ts`. It mocks `executeCapability`, `runModeFor` and `@/db/client`; there is no network or database.

1. **Real payload becomes the exact capability input (end-to-end wiring):**
   - Build a payload by parsing `{ profileType: "zillow", profileUrl: URL, severity: "high" }` with `eventDefinition("profile.error_detected").schema`.
   - Build the run input exactly as `bus.ts` does (`{ event: {…}, payload }`).
   - Run the workflow's actual `entry` handler, which must succeed.
   - Run the workflow's actual `fetch_profile` handler with `inputs: { entry: <entry output> }` and the node's own config.
   - Assert that `executeCapability` was called once with `capability: "cms.fetch_public_page"`, `input` **toEqual `{ url: URL }`**, `projectId === ctx.projectId` and `workflowRunId === ctx.runId`.
2. **Entry accepts the event start:** `profileCorrectionWorkflow`'s `entry` handler is `trg.domain_event` and succeeds on the event-shaped input, re-publishing `eventId`, `correlationId` and `payload.profileUrl`.
3. **Scheduled start is refused explicitly:** the same entry handler returns `failed_terminal` with the mismatch message on `{ trigger: { kind: "schedule" } }`, and no connector is called.
4. **Missing value is omitted, not invented:** with no `profileUrl`, the capability input is `{}`.
5. **Precedence:** `params` are defaults under `inputFields`; `inputPath` + `inputFields` together is refused.
6. **Malformed `inputFields`** (array, non-string value) fails terminally, and `executeCapability` is not called.
7. **Regression:** a node without `inputFields` (for example competitor intelligence `fetch_source`, `inputPath: "competitor_fan"`) sends the same payload as before.
8. **Validation:**
   - `validateAutomationDefinition(profileCorrectionWorkflow)` returns `[]`.
   - `validateNodePaths` reports a non-ancestor root in `inputFields` and a malformed `inputFields`.
   - `fetch_profile.config` has `inputFields: { url: "payload.profileUrl" }` and no `inputPath`.

Re-run: `profile-canonical-claim-extraction`, `profile-correction-workflow`, `automation-workflows`, `automation-mapping`, `automation-triggers` and `agent-context-paths`, then the full unit suite.

## Acceptance Criteria
- [x] A `profile.error_detected` run passes `entry` and calls `cms.fetch_public_page` with exactly `{ url: payload.profileUrl }`.
- [x] The event payload schema, trigger declarations and idempotency template are unchanged.
- [x] No connector adapter changes, and no other workflow definition changes.
- [x] Integration nodes without `inputFields` build the same payload as before.
- [x] Tenant scope, provenance, test-mode behavior and Spec 145B behavior are preserved.
- [x] `npm run typecheck`, `npm run lint`, the relevant tests and `git diff --check` pass.

## Files Expected To Change
- `lib/automation/workflows/authority.ts`: the `entry` kind, and `fetch_profile` `inputFields`.
- `lib/automation/nodes/integration.ts`: `inputFields` in `payloadFor`.
- `lib/automation/runtime.ts`: validate `inputFields` paths.
- `tests/unit/profile-correction-live-input.test.ts` (new).
- `DECISIONS.md`: node-level `inputFields` mapping rather than changing the connector or event, and `domain_event` entry for this workflow.
- This spec: tick the acceptance criteria.

## Risks
- A template could use `inputFields` to feed a guarded node (send, publish, invoice). This is no wider than `inputPath` already allows, and those nodes' own gates are unchanged.
- Scheduled `profile_scan` runs now fail at `entry` instead of safe-stopping after a failed connector call. Both outcomes are "did nothing"; the new one says why without calling a provider.

> **RESOLVED (2026-09-23):** The `schedule` trigger stays declared. Scheduled `profile_scan` runs carry no profile URL and fail at `entry` with the existing mismatch message; no URL is invented. A later spec defines the scan's profile source.
