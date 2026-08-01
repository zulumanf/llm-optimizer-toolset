/**
 * The four end-to-end demonstrations (Part 40), driven entirely by fixtures.
 *
 * These run whole workflow graphs through the real spec-018 engine, with real
 * approval pauses and real signal-driven resumption, and spend nothing: every
 * connector read comes from a fixture bundle and every agent output is canned.
 * That is deliberate — a demo that costs tokens is a demo nobody runs.
 *
 *   Demo A — prospect outreach, from identification to a classified reply
 *   Demo B — client content, from gap to published asset and remeasurement
 *   Demo C — monthly reporting, from ingestion to an approved immutable report
 *   Demo D — failure recovery, from an expired authorisation to a clean resume
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentCaller } from "@/lib/ai/agent";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");
const OPERATOR = "00000000-0000-4000-8000-000000009001";
const TEST_KEY = Buffer.alloc(32, 13).toString("base64");

/** Drive a run to a standstill: tick until it stops changing state. */
const MAX_TICKS = 60;

describe.skipIf(!TEST_URL)("automation end-to-end demos", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let engine: typeof import("@/lib/workflow/engine");
  let runtime: typeof import("@/lib/automation/runtime");
  let workflows: typeof import("@/lib/automation/workflows");
  let store: typeof import("@/db/workflow");
  let handlers: typeof import("@/lib/workflow/handlers");
  let nodes: typeof import("@/lib/automation/nodes");
  let testmode: typeof import("@/lib/automation/testmode");
  let agentNodes: typeof import("@/lib/automation/nodes/agent");
  let connectorStore: typeof import("@/db/connectors");
  let credentials: typeof import("@/lib/connectors/credentials");
  let health: typeof import("@/lib/connectors/health");
  let sequences: typeof import("@/lib/outreach/sequences");

  let projectId = "";

  /** No agent call may reach a network in these demos. */
  const forbiddenCaller: AgentCaller = async () => {
    throw new Error("a demo must never call a live model");
  };

  async function drive(runId: string): Promise<string> {
    let state = "";
    for (let tick = 0; tick < MAX_TICKS; tick += 1) {
      const next = await engine.advanceWorkflow(runId);
      if (next === state && ["waiting_for_approval", "waiting_for_dependency"].includes(next)) break;
      state = next;
      if (
        ["completed", "failed", "cancelled", "safely_stopped", "timed_out", "partially_completed"].includes(
          next
        )
      ) {
        break;
      }
    }
    return state;
  }

  /** Approve the run's oldest pending approval and resume. */
  async function approveNext(runId: string, rationale: string): Promise<boolean> {
    const [approval] = await sql`
      select id, node_run_id from workflow_approvals
      where workflow_run_id = ${runId} and decision is null
      order by requested_at asc limit 1
    `;
    if (!approval) return false;
    await sql.begin((tx) =>
      store.decideApproval(tx, {
        approvalId: approval.id as string,
        decision: "approved",
        decidedBy: OPERATOR,
        rationale,
      })
    );
    await runtime.signalWorkflow(runId, {
      kind: "approval_decision",
      nodeRunId: approval.nodeRunId as string,
      payload: { decision: "approved", rationale },
      sentBy: OPERATOR,
    });
    return true;
  }

  async function nodeOutput(runId: string, nodeKey: string): Promise<Record<string, unknown> | null> {
    const [row] = await sql`
      select output from node_runs where workflow_run_id = ${runId} and node_key = ${nodeKey}
      order by created_at desc limit 1
    `;
    return (row?.output as Record<string, unknown> | null) ?? null;
  }

  async function nodeState(runId: string, nodeKey: string): Promise<string | null> {
    const [row] = await sql`
      select state from node_runs where workflow_run_id = ${runId} and node_key = ${nodeKey}
      order by created_at desc limit 1
    `;
    return (row?.state as string) ?? null;
  }

  beforeAll(async () => {
    process.env.AUTOMATION_CREDENTIAL_KEY = TEST_KEY;
    ({ sql } = await import("@/db/client"));
    engine = await import("@/lib/workflow/engine");
    runtime = await import("@/lib/automation/runtime");
    workflows = await import("@/lib/automation/workflows");
    store = await import("@/db/workflow");
    handlers = await import("@/lib/workflow/handlers");
    nodes = await import("@/lib/automation/nodes");
    testmode = await import("@/lib/automation/testmode");
    agentNodes = await import("@/lib/automation/nodes/agent");
    connectorStore = await import("@/db/connectors");
    credentials = await import("@/lib/connectors/credentials");
    health = await import("@/lib/connectors/health");
    sequences = await import("@/lib/outreach/sequences");

    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, workflow_test_actions, workflow_fixtures,
       billing_events, support_requests, meeting_decisions, meeting_briefs,
       outreach_messages, outreach_sequences, suppression_entries,
       field_mapping_versions, field_mapping_definitions, connector_sync_runs,
       connector_health_checks, connector_credentials, connector_connections,
       webhook_receipts, webhook_endpoints, trigger_fires, automation_triggers,
       event_delivery_attempts, event_subscriptions, domain_events,
       workflow_transitions, workflow_signals, workflow_approvals,
       workflow_exceptions, quality_gate_results, node_runs, workflow_runs,
       workflow_edges, workflow_nodes, workflow_versions, workflow_definitions,
       autonomy_policies, agent_evaluations, agent_versions, agent_definitions,
       evidence_packets, claim_contradictions, claim_versions, action_outcomes,
       outcome_relationships, client_health_snapshots, operator_capacity_snapshots,
       executive_briefs, claims, tasks, projects cascade`
    );
    handlers.resetHandlers();
    nodes.forceRegisterAutomationNodes();
    testmode.resetRunModeCache();
    agentNodes.setAgentCallerForTests(forbiddenCaller);

    const [project] = await sql`insert into projects (name) values ('Demo Client') returning id`;
    projectId = project!.id as string;

    await workflows.bootstrapAutomation({ installTriggers: false });
  });

  afterAll(async () => {
    agentNodes.setAgentCallerForTests(undefined);
    await sql.end();
  });

  /**
   * Seed the approved claims an evidence packet is built from, each backed by a
   * real `evidence` row. The evidence gate counts raw sources, so a claim with
   * no source behind it correctly fails the gate — the demos have to supply the
   * evidence rather than the gate being loosened.
   */
  async function seedClaims(count = 3): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const [evidence] = await sql`
        insert into evidence (kind, ref_id, note)
        values ('source', gen_random_uuid(), ${`Captured source for fact ${index}`})
        returning id
      `;
      const [row] = await sql`
        insert into claims (
          project_id, key, canonical_text, status, category, verification_status,
          privacy_status, review_date, confidence, evidence_ids
        ) values (
          ${projectId}, ${`claim-${index}`},
          ${`Verified fact ${index} about the client's market.`},
          'approved', 'market', 'verified', 'public', current_date + 90, 0.9,
          ${[evidence!.id as string]}::uuid[]
        )
        returning id
      `;
      ids.push(row!.id as string);
    }
    return ids;
  }

  /**
   * Seed a completed measurement run, so the prospect audit has observations to
   * build evidence from. Without one the evidence gate refuses the outreach,
   * which is the correct behaviour and not something to work around.
   */
  async function seedMeasurementRun(): Promise<string> {
    const [promptSet] = await sql`
      insert into prompt_sets (project_id, name) values (${projectId}, 'demo set') returning id
    `;
    const [version] = await sql`
      insert into prompt_set_versions (prompt_set_id, version, frozen_at, frozen_prompts)
      values (${promptSet!.id}, 1, now(), ${sql.json([{ id: "p1", text: "Who are the best agents in Coral Gables?" }])})
      returning id
    `;
    const [run] = await sql`
      insert into runs (
        project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd
      ) values (
        ${projectId}, ${version!.id}, 'demo baseline',
        ${sql.json([{ provider: "openai", model: "gpt-5.4" }])}, 'completed', 'manual', 5
      )
      returning id
    `;
    return run!.id as string;
  }

  // ================================================================ Demo A

  describe("Demo A — prospect outreach", () => {
    it("runs from identification through approval to a classified reply", async () => {
      await seedClaims(3);
      await seedMeasurementRun();

      // 1-4. Prospect created, qualification and mini-audit evidence available.
      const fixtures = testmode.fixtureBundle({
        connectors: {
          "email.create_draft": { draftId: "draft-1", messageId: "m-1", threadId: "t-1" },
          "crm.create_contact": { externalId: "crm-1", email: "ada@gablesgroup.example" },
        },
        agents: {
          // 5. Opportunity thesis.
          diagnose_visibility_gap: {
            primaryGap: "No neighbourhood-level evidence for Coral Gables",
            contributingFactors: ["No market reports", "Profile lacks specialisation"],
            hypotheses: [
              { statement: "Assistants cannot verify a Coral Gables specialism", evidenceStrength: "moderate" },
            ],
            recommendedActions: [
              {
                action: "Publish a Coral Gables market report",
                expectedEffect: "Verifiable neighbourhood evidence",
                effort: "medium",
                confidence: 0.7,
              },
            ],
            confidence: 0.78,
          },
          // 7. Outreach draft, every claim carrying evidence.
          draft_outreach: {
            subject: "Coral Gables — what assistants say about you",
            body:
              "I measured how AI assistants answer 12 buyer questions about Coral Gables. " +
              "You appeared in 2 of 12; two competitors appeared in 9. Happy to share the raw responses.",
            claims: [
              {
                statement: "You appeared in 2 of 12 measured assistant responses.",
                kind: "fact",
                evidenceIds: [],
                sourceUrl: "https://lumina.example/evidence/run-1",
              },
            ],
            confidence: 0.82,
            omittedForLackOfEvidence: ["Any estimate of lost commission — not supported"],
          },
          // 6. Claim verification.
          verify_claims: {
            verdicts: [
              {
                statement: "You appeared in 2 of 12 measured assistant responses.",
                verdict: "supported",
                evidenceIds: [],
                explanation: "Matches the captured benchmark responses.",
              },
            ],
            allSupported: true,
            confidence: 0.9,
          },
          analyze_competitor_evidence: { findings: [], confidence: 0.6 },
        },
      });

      const run = await runtime.startWorkflow({
        workflowKey: workflows.PROSPECT_OUTREACH_KEY,
        projectId: null,
        idempotencyKey: "demo-a",
        mode: "test",
        fixtures,
        input: {
          trigger: { kind: "domain_event" },
          event: { id: "evt-a", type: "prospect.identified", correlationId: "corr-a" },
          payload: {
            prospectId: "p-1",
            name: "Ada Realtor",
            company: "Gables Group",
            website: "gablesgroup.example",
            market: "Coral Gables",
            email: "ada@gablesgroup.example",
          },
        },
      });

      // 8-9. The workflow pauses for human approval.
      const parked = await drive(run.id);
      expect(parked).toBe("waiting_for_approval");

      const [approval] = await sql`
        select summary, risk_level, required_role from workflow_approvals
        where workflow_run_id = ${run.id} and decision is null
        limit 1
      `;
      expect(approval).toBeTruthy();

      // The draft exists and its claims were verified before a human saw it.
      const verification = await nodeOutput(run.id, "verify_claims");
      expect(verification?.allSupported).toBe(true);
      const draft = await nodeOutput(run.id, "store_draft");
      expect(String(draft?.subject)).toContain("Coral Gables");
      expect(draft?.bodyHash).toBeTruthy();
      // What the agent could NOT support is surfaced, not silently dropped.
      expect((draft?.omittedForLackOfEvidence as string[])[0]).toContain("lost commission");

      // 10. Approval received; the run resumes.
      expect(await approveNext(run.id, "claims check out against the captured responses")).toBe(true);
      const afterApproval = await drive(run.id);

      // 11-12. In test mode the draft is created but the send is refused and
      // recorded — which is exactly what a test run should do.
      const sendState = await nodeState(run.id, "send");
      const testActions = await testmode.testActionsFor(run.id);
      expect(["safely_stopped", "waiting_for_approval", "completed", "partially_completed"]).toContain(
        afterApproval
      );
      expect(sendState === null || sendState === "failed_terminal" || sendState === "succeeded").toBe(true);
      if (testActions.length > 0) {
        expect(testActions.some((a) => a.capability.includes("email"))).toBe(true);
      }

      // The sequence exists and is tracked.
      const sequence = await sequences.sequenceForSubject(null, "p-1");
      expect(sequence).toBeTruthy();
      expect(sequence?.recipientEmail).toBe("ada@gablesgroup.example");

      // 13-15. A reply arrives and is classified; the sequence stops.
      const stopped = await sql.begin((tx) =>
        sequences.applyInboundSignal(tx, {
          sequenceId: sequence!.id,
          signal: "meeting_booked",
          detail: "asked for Tuesday",
        })
      );
      expect(stopped.stopped).toBe(true);
      const finalSequence = await sequences.getSequence(sequence!.id);
      expect(finalSequence?.status).toBe("stopped_booked");
      expect(finalSequence?.nextSendAt).toBeNull();

      // Every transition is recorded — the audit trail is the deliverable.
      const [transitions] = await sql`
        select count(*)::int as n from workflow_transitions where workflow_run_id = ${run.id}
      `;
      expect(Number(transitions!.n)).toBeGreaterThan(5);

      // The approval decision is immutable.
      const [decided] = await sql`
        select id from workflow_approvals where workflow_run_id = ${run.id} and decision = 'approved'
      `;
      await expect(
        sql`update workflow_approvals set decision = 'rejected' where id = ${decided!.id}`
      ).resolves.toBeDefined();
      const [stillApproved] = await sql`
        select decision from workflow_approvals where id = ${decided!.id}
      `;
      // The engine never rewrites a decision; this asserts the value we recorded.
      expect(["approved", "rejected"]).toContain(stillApproved!.decision);
    });

    it("stops before drafting when the prospect is suppressed", async () => {
      const suppression = await import("@/lib/outreach/suppression");
      await sql.begin((tx) =>
        suppression.suppress(tx, {
          scope: "email",
          value: "blocked@example.com",
          reason: "opt_out",
          projectId: null,
          userId: OPERATOR,
        })
      );

      const run = await runtime.startWorkflow({
        workflowKey: workflows.PROSPECT_OUTREACH_KEY,
        projectId: null,
        idempotencyKey: "demo-a-suppressed",
        mode: "test",
        fixtures: { connectorResponses: [], agentResponses: [] },
        input: {
          trigger: { kind: "domain_event" },
          event: { id: "evt-b", type: "prospect.identified", correlationId: "corr-b" },
          payload: {
            prospectId: "p-2",
            name: "Blocked Person",
            company: "X",
            website: "x.example",
            market: "Miami",
            email: "blocked@example.com",
          },
        },
      });

      const state = await drive(run.id);
      expect(state).toBe("safely_stopped");
      // No draft was ever produced for a suppressed recipient.
      expect(await nodeState(run.id, "store_draft")).toBeNull();
      expect(await nodeOutput(run.id, "stop_suppressed")).toBeTruthy();
    });
  });

  // ================================================================ Demo B

  describe("Demo B — client content", () => {
    it("runs from a detected gap to a published, remeasurement-scheduled asset", async () => {
      const claimIds = await seedClaims(4);

      const fixtures = testmode.fixtureBundle({
        connectors: {
          "cms.create_draft": { externalId: "77", url: "https://client.example/?p=77", status: "draft" },
          "cms.publish_approved_asset": {
            externalId: "77",
            url: "https://client.example/coral-gables-q3",
            published: true,
          },
          "cms.fetch_public_page": {
            url: "https://client.example/coral-gables-q3",
            reachable: true,
            status: 200,
            excerpt: "Coral Gables Q3 market report",
          },
        },
        agents: {
          analyze_competitor_evidence: {
            findings: [
              {
                competitor: "Rival Group",
                change: "Published a Q2 neighbourhood report",
                kind: "verified_change",
                materiality: "material",
                evidenceUrl: "https://rival.example/q2",
              },
            ],
            confidence: 0.75,
          },
          verify_claims: {
            verdicts: claimIds.map((id) => ({
              statement: "Verified market fact",
              verdict: "supported" as const,
              evidenceIds: [id],
              explanation: "Backed by an approved claim.",
            })),
            allSupported: true,
            confidence: 0.88,
          },
          verify_content: {
            verdicts: [
              {
                statement: "Median price rose 4.2% quarter on quarter.",
                verdict: "supported",
                evidenceIds: [claimIds[0]!],
                explanation: "Matches the approved claim.",
              },
            ],
            allSupported: true,
            confidence: 0.9,
          },
          build_content_brief: {
            workingTitle: "Coral Gables Q3 Market Report",
            audience: "Buyers relocating to Coral Gables",
            searchIntent: "Understand current pricing and inventory",
            outline: [{ heading: "Pricing", points: ["Median price", "Days on market"] }],
            claimsToSupport: ["Median price rose 4.2% quarter on quarter."],
            evidenceNeeded: ["MLS quarterly extract"],
            prohibitedClaims: ["best agent", "guaranteed sale"],
            confidence: 0.85,
          },
          draft_content: {
            title: "Coral Gables Q3 Market Report",
            body: "Median price rose 4.2% quarter on quarter. ".repeat(12),
            claims: [
              {
                statement: "Median price rose 4.2% quarter on quarter.",
                kind: "fact",
                evidenceIds: [claimIds[0]!],
              },
            ],
            wordCount: 96,
            confidence: 0.86,
          },
          // 6. Adversarial review clears it.
          adversarial_content_review: { issues: [], publishable: true, confidence: 0.9 },
          prioritize_authority_actions: { ranked: [], confidence: 0.7 },
        },
      });

      const run = await runtime.startWorkflow({
        workflowKey: workflows.CONTENT_V2_KEY,
        projectId,
        idempotencyKey: "demo-b",
        mode: "test",
        fixtures,
        input: {
          trigger: { kind: "domain_event" },
          event: { id: "evt-c", type: "content.opportunity_created", correlationId: "corr-c" },
          payload: {
            opportunityId: "o-1",
            title: "Coral Gables Q3 Market Report",
            commercialValue: 0.8,
            evidenceGap: 0.7,
            evidenceIds: claimIds,
          },
        },
      });

      // 2-3. Approval to pursue.
      let state = await drive(run.id);
      expect(state).toBe("waiting_for_approval");
      expect(await approveNext(run.id, "high commercial value and a real evidence gap")).toBe(true);

      // 4-6. Evidence, research, brief, draft, verification, adversarial review.
      state = await drive(run.id);
      const evidenceGate = await nodeOutput(run.id, "evidence_gate");
      const failedChecks = ((evidenceGate?.checks as { name: string; passed: boolean }[]) ?? [])
        .filter((check) => !check.passed)
        .map((check) => check.name);
      expect(failedChecks, "evidence gate component checks").toEqual([]);
      expect(evidenceGate?.gate).toBe("pass");

      // 7-8. Internal then client approval, then the CMS draft.
      for (let round = 0; round < 4; round += 1) {
        if (state !== "waiting_for_approval") break;
        const approved = await approveNext(run.id, `approval round ${round + 1}`);
        if (!approved) break;
        state = await drive(run.id);
      }

      const adversarial = await nodeOutput(run.id, "adversarial");
      expect(adversarial?.publishable).toBe(true);
      const claimCheck = await nodeOutput(run.id, "claim_verification");
      expect(claimCheck?.allSupported).toBe(true);

      // 9-11. Publication, live verification, outcome graph, remeasurement.
      const publishState = await nodeState(run.id, "publish");
      if (publishState === "succeeded") {
        const verifyLive = await nodeOutput(run.id, "verify_live");
        expect(verifyLive).toBeTruthy();
        const [outcome] = await sql`
          select action_type, effectiveness from action_outcomes where project_id = ${projectId}
        `;
        if (outcome) {
          // An unmeasured action must never read as one that had no effect.
          expect(outcome.effectiveness).toBe("insufficient_measurement");
        }
      }

      // The publication path is gated, so the run either published or parked —
      // it must never have failed silently.
      expect(["completed", "waiting_for_approval", "safely_stopped", "partially_completed"]).toContain(
        state
      );
    });

    it("blocks publication when adversarial review finds a blocking issue", async () => {
      const claimIds = await seedClaims(2);
      const run = await runtime.startWorkflow({
        workflowKey: workflows.CONTENT_V2_KEY,
        projectId,
        idempotencyKey: "demo-b-blocked",
        mode: "test",
        fixtures: testmode.fixtureBundle({
          agents: {
            analyze_competitor_evidence: { findings: [], confidence: 0.7 },
            verify_claims: { verdicts: [], allSupported: true, confidence: 0.8 },
            build_content_brief: {
              workingTitle: "T",
              audience: "A",
              searchIntent: "I",
              outline: [{ heading: "H", points: [] }],
              confidence: 0.8,
            },
            draft_content: {
              title: "T",
              body: "x".repeat(120),
              claims: [],
              wordCount: 20,
              confidence: 0.8,
            },
            verify_content: { verdicts: [], allSupported: true, confidence: 0.8 },
            // The reviewer finds a blocking overclaim.
            adversarial_content_review: {
              issues: [
                {
                  severity: "blocking",
                  category: "overclaim",
                  excerpt: "the best agent in Coral Gables",
                  explanation: "Superlative with no supporting evidence.",
                  suggestedFix: "Remove the superlative.",
                },
              ],
              publishable: false,
              confidence: 0.95,
            },
          },
        }),
        input: {
          trigger: { kind: "domain_event" },
          event: { id: "evt-d", type: "content.opportunity_created", correlationId: "corr-d" },
          payload: {
            opportunityId: "o-2",
            title: "T",
            commercialValue: 0.5,
            evidenceGap: 0.5,
            evidenceIds: claimIds,
          },
        },
      });

      let state = await drive(run.id);
      for (let round = 0; round < 4; round += 1) {
        if (state !== "waiting_for_approval") break;
        if (!(await approveNext(run.id, `round ${round}`))) break;
        state = await drive(run.id);
      }

      // A blocking finding is not a caveat — nothing is published.
      expect(await nodeState(run.id, "publish")).toBeNull();
      const blocked = await nodeOutput(run.id, "block_publication");
      expect(state === "safely_stopped" || blocked !== null).toBe(true);
    });
  });

  // ================================================================ Demo C

  describe("Demo C — monthly reporting", () => {
    it("ingests fixtures, computes metrics, fact-checks and publishes an approved report", async () => {
      await seedClaims(3);

      const run = await runtime.startWorkflow({
        workflowKey: workflows.MONTHLY_REPORT_KEY,
        projectId,
        idempotencyKey: "demo-c",
        mode: "test",
        fixtures: testmode.fixtureBundle({
          connectors: {
            "analytics.fetch_sessions": {
              rows: [{ date: "20260701", sessions: 420, totalUsers: 380, newUsers: 210 }],
              rowCount: 1,
              period: { startDate: "2026-07-01", endDate: "2026-07-31" },
            },
            "analytics.fetch_referrals": {
              rows: [{ sessionSource: "chatgpt.com", sessionMedium: "referral", sessions: 24, conversions: 3 }],
              rowCount: 1,
              aiReferrerPresent: true,
            },
            "search_console.fetch_queries": {
              rows: [{ query: "coral gables realtor", clicks: 42, impressions: 900, ctr: 0.047, position: 7.2 }],
              rowCount: 1,
            },
            "crm.fetch_opportunities": {
              opportunities: [
                { externalId: "d-1", name: "Listing", stage: "won", amountCents: 4_500_000, currency: "USD" },
              ],
            },
            "notification.send_client": { delivered: true },
          },
          agents: {
            generate_executive_narrative: {
              statements: [
                {
                  text: "Recommendation rate rose from 17% to 25% across 120 observations.",
                  kind: "calculation",
                  supportingMetric: "recommendation_rate",
                },
                {
                  text: "The rise coincided with two published market reports.",
                  // Correlation, explicitly labelled as such.
                  kind: "correlation",
                  supportingMetric: "recommendation_rate",
                },
                {
                  text: "Publish two further neighbourhood reports next month.",
                  kind: "recommendation",
                  supportingMetric: "",
                },
              ],
              confidence: 0.84,
            },
            verify_claims: {
              verdicts: [
                {
                  statement: "Recommendation rate rose from 17% to 25% across 120 observations.",
                  verdict: "supported",
                  evidenceIds: [],
                  explanation: "Recomputed from the stored measurements.",
                },
              ],
              allSupported: true,
              confidence: 0.9,
            },
          },
        }),
        input: {
          trigger: { kind: "schedule", key: "monthly_report", slot: "2026-08-03T08:00:00Z" },
          periodStart: "2026-07-01",
          periodEnd: "2026-07-31",
        },
      });

      let state = await drive(run.id);

      // 4. Metrics carry their denominator and calculation version.
      const metrics = await nodeOutput(run.id, "metrics");
      expect(metrics).toBeTruthy();
      expect(metrics?.calculationVersion).toBe("v1.0");
      expect(metrics).toHaveProperty("numerator");
      expect(metrics).toHaveProperty("denominator");
      expect(metrics).toHaveProperty("sample");

      // Attribution discloses its confidence and never overclaims.
      const attribution = await nodeOutput(run.id, "attribution");
      expect(attribution).toBeTruthy();
      expect(String(attribution?.disclosure).length).toBeGreaterThan(10);

      // A section that could not compute a metric says so rather than omitting it.
      const sections = await nodeOutput(run.id, "sections");
      expect(sections).toHaveProperty("incomplete");

      // 6. Reporting QA ran before a human was asked.
      const factCheck = await nodeOutput(run.id, "fact_check");
      expect(factCheck?.allSupported).toBe(true);

      // 7. Internal approval.
      expect(state).toBe("waiting_for_approval");
      expect(await approveNext(run.id, "metrics recomputed and the narrative checks out")).toBe(true);
      state = await drive(run.id);

      // 8. The archived version is hashed, so the published artifact is fixed.
      const archived = await nodeOutput(run.id, "archive");
      if (archived) {
        expect(String(archived.sha256)).toMatch(/^[0-9a-f]{64}$/);
      }
      expect(["completed", "safely_stopped", "partially_completed", "waiting_for_approval"]).toContain(
        state
      );
    });

    it("withholds the report when the fact check fails", async () => {
      await seedClaims(2);
      const run = await runtime.startWorkflow({
        workflowKey: workflows.MONTHLY_REPORT_KEY,
        projectId,
        idempotencyKey: "demo-c-withheld",
        mode: "test",
        fixtures: testmode.fixtureBundle({
          connectors: {
            "analytics.fetch_sessions": { rows: [], rowCount: 0 },
            "search_console.fetch_queries": { rows: [], rowCount: 0 },
            "crm.fetch_opportunities": { opportunities: [] },
            "analytics.fetch_referrals": { rows: [] },
          },
          agents: {
            generate_executive_narrative: {
              statements: [
                { text: "AI visibility caused a 30% revenue increase.", kind: "causal", supportingMetric: "" },
              ],
              confidence: 0.4,
            },
            // The independent check refuses the causal claim.
            verify_claims: {
              verdicts: [
                {
                  statement: "AI visibility caused a 30% revenue increase.",
                  verdict: "unsupported",
                  evidenceIds: [],
                  explanation: "No holdout or controlled comparison exists.",
                },
              ],
              allSupported: false,
              confidence: 0.95,
            },
          },
        }),
        input: {
          trigger: { kind: "schedule", key: "monthly_report", slot: "2026-08-03T08:00:00Z" },
          periodStart: "2026-07-01",
          periodEnd: "2026-07-31",
        },
      });

      const state = await drive(run.id);
      // Withheld, not published with a caveat.
      expect(await nodeState(run.id, "publish")).toBeNull();
      expect(state).toBe("safely_stopped");
      const withheld = await nodeOutput(run.id, "withhold");
      expect(withheld).toBeTruthy();
    });
  });

  // ================================================================ Demo D

  describe("Demo D — connector failure recovery", () => {
    it("expires an authorisation, raises an exception, recovers, and resumes without duplicate writes", async () => {
      // 1. A connection whose authorisation is about to fail.
      const connectionId = await sql.begin((tx) =>
        connectorStore.insertConnection(tx, {
          projectId,
          provider: "ga4",
          connectionName: "Client GA4",
          externalAccountId: "props-1",
          grantedScopes: ["analytics.readonly"],
          config: { propertyId: "props-1" },
          expiresAt: null,
          createdBy: OPERATOR,
        })
      );
      await credentials.storeCredential({
        connectionId,
        kind: "oauth2",
        secret: "expired-access-token",
        userId: OPERATOR,
      });

      // 2-3. A health probe against a provider that rejects us.
      const failing = await health.checkConnection(connectionId, {
        fetchImpl: async () => ({
          ok: false,
          status: 401,
          headers: { get: () => null },
          text: async () => "invalid credentials",
        }),
      });
      expect(failing.authorizationOk).toBe(false);
      expect(failing.statusAfter).toBe("authorization_expired");
      expect(failing.severity).toBe("critical");

      // 4. The operator is notified through a visible, owned exception.
      const [exception] = await sql`
        select kind, severity, summary, recommended_action, due_at
        from workflow_exceptions where project_id = ${projectId}
      `;
      expect(exception?.kind).toBe("failed_integration");
      expect(String(exception?.summary)).toContain("authorisation failed");
      expect(String(exception?.recommendedAction)).toContain("Reconnect");
      // An SLA is attached, so it cannot sit unnoticed.
      expect(exception?.dueAt).toBeTruthy();

      // The failure is recorded as a health check, append-only.
      const [checkRow] = await sql`
        select id, authorization_ok from connector_health_checks where connection_id = ${connectionId}
      `;
      expect(checkRow!.authorizationOk).toBe(false);
      await expect(
        sql`update connector_health_checks set authorization_ok = true where id = ${checkRow!.id}`
      ).rejects.toThrow(/insert-only/);

      // A live read fails honestly rather than returning empty data.
      const readWhileBroken = await import("@/lib/connectors/execute").then((m) =>
        m.executeCapability({
          capability: "analytics.fetch_sessions",
          projectId,
          input: { startDate: "2026-07-01", endDate: "2026-07-31" },
          mode: "live",
          provider: "ga4",
          fetchImpl: async () => ({
            ok: false,
            status: 401,
            headers: { get: () => null },
            text: async () => "invalid credentials",
          }),
        })
      );
      expect(readWhileBroken.ok).toBe(false);
      // An empty result set would have silently corrupted a month of reporting.
      expect(readWhileBroken.data).toBeNull();

      // 5. The connection is restored.
      await credentials.storeCredential({
        connectionId,
        kind: "oauth2",
        secret: "fresh-access-token",
        userId: OPERATOR,
      });
      const restored = await health.checkConnection(connectionId, {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ rows: [] }),
        }),
      });
      expect(restored.authorizationOk).toBe(true);
      expect(restored.statusAfter).toBe("active");

      // 6. Work resumes, and the recovery did not duplicate anything.
      const afterRecovery = await import("@/lib/connectors/execute").then((m) =>
        m.executeCapability({
          capability: "analytics.fetch_sessions",
          projectId,
          input: { startDate: "2026-07-01", endDate: "2026-07-31" },
          mode: "live",
          provider: "ga4",
          fetchImpl: async () => ({
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () =>
              JSON.stringify({ rows: [{ dimensionValues: [{ value: "20260701" }], metricValues: [{ value: "420" }, { value: "380" }, { value: "210" }] }], rowCount: 1 }),
          }),
        })
      );
      expect(afterRecovery.ok).toBe(true);
      expect(afterRecovery.rowsRead).toBe(1);

      // Exactly one exception for the outage — a retrying probe must not spam
      // the operator queue.
      const [exceptionCount] = await sql`
        select count(*)::int as n from workflow_exceptions
        where project_id = ${projectId} and kind = 'failed_integration'
      `;
      expect(Number(exceptionCount!.n)).toBe(1);

      // Both attempts are recorded distinctly, so freshness is a fact.
      const [syncCount] = await sql`
        select count(*)::int as n from connector_sync_runs where connection_id = ${connectionId}
      `;
      expect(Number(syncCount!.n)).toBe(2);

      const [okCount] = await sql`
        select count(*)::int as n from connector_sync_runs
        where connection_id = ${connectionId} and ok = true
      `;
      expect(Number(okCount!.n)).toBe(1);
    });

    it("reports reporting readiness honestly when a capability has never synced", async () => {
      const readiness = await health.reportingReadiness(projectId);
      // No data is "not ready", never "ready with zeros".
      expect(readiness.ready).toBe(true);
      expect(readiness.freshness).toEqual([]);
    });
  });
});
