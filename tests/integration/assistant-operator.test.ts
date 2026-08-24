/**
 * Spec 096 — the assistant's human gate, end to end: a confirm-tier tool
 * call stages a pending action and executes nothing; only the confirm
 * server path (the operator's click) executes; tokens are single-use,
 * expiring, and user-bound.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import type { AgentCaller } from "@/lib/ai/agent";
import { seedTestActors } from "../helpers/actors";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};
const admin: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};

const P1 = "aaaaaaaa-0000-4000-8000-000000000011";

const scripted = (steps: object[]): AgentCaller => {
  let i = 0;
  return async () => ({
    text: JSON.stringify(steps[Math.min(i++, steps.length - 1)]),
    tokensIn: 100,
    tokensOut: 20,
  });
};

describe.skipIf(!TEST_URL)("assistant operator mode (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let confirm: typeof import("@/lib/assistant/confirm");
  let assistant: typeof import("@/lib/assistant/service");

  async function newConversation(user: CurrentUser): Promise<string> {
    const [row] = await sql`
      insert into assistant_conversations (user_id, title)
      values (${user.id}, 't') returning id
    `;
    return row!.id as string;
  }

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    confirm = await import("@/lib/assistant/confirm");
    assistant = await import("@/lib/assistant/service");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
    await sql`insert into markets (id, name, kind) values ('bbbbbbbb-0000-4000-8000-000000000011', 'M', 'city')`;
    await sql`insert into market_launches (id, name, market_id, status)
      values ('cccccccc-0000-4000-8000-000000000011', 'L', 'bbbbbbbb-0000-4000-8000-000000000011', 'researching')`;
    await sql`insert into prospects (id, launch_id, business_name, prospect_type, stage)
      values (${P1}, 'cccccccc-0000-4000-8000-000000000011', 'Gate Co', 'team', 'identified')`;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("a confirm-tier tool through the loop stages a pending action and executes nothing", async () => {
    const reply = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "advance Gate Co to researching" },
        scripted([
          {
            action: "tool",
            tool: "advance_stage",
            input: { prospect_id: P1, stage: "researching" },
          },
          { action: "answer", answer: "Staged for your confirmation." },
        ])
      )
    );
    expect(reply.pendingActions.length).toBe(1);
    expect(reply.pendingActions[0]!.tool).toBe("advance_stage");
    // NOTHING executed: the prospect has not moved.
    const [p] = await sql`select stage from prospects where id = ${P1}`;
    expect(p?.stage).toBe("identified");
  });

  it("confirming executes as the human, single-use", async () => {
    const conversationId = await newConversation(operator);
    const pending = await confirm.mintPendingAction(operator, conversationId, "advance_stage", {
      prospect_id: P1,
      stage: "researching",
    });
    const result = unwrap(await confirm.confirmAssistantAction(operator, { token: pending.token }));
    expect(result.summary).toContain("researching");
    const [p] = await sql`select stage from prospects where id = ${P1}`;
    expect(p?.stage).toBe("researching");
    // Replay refuses.
    const replay = await confirm.confirmAssistantAction(operator, { token: pending.token });
    expect(replay.ok).toBe(false);
  });

  it("a token is user-bound and expiring", async () => {
    const conversationId = await newConversation(operator);
    const pending = await confirm.mintPendingAction(operator, conversationId, "advance_stage", {
      prospect_id: P1,
      stage: "benchmarking",
    });
    // Another staff user cannot confirm someone else's proposal.
    const stranger = await confirm.confirmAssistantAction(admin, { token: pending.token });
    expect(stranger.ok).toBe(false);
    // Expired tokens refuse and flip to expired.
    await sql`
      update assistant_pending_actions set created_at = now() - interval '1 hour'
      where token = ${pending.token}
    `;
    const late = await confirm.confirmAssistantAction(operator, { token: pending.token });
    expect(late.ok).toBe(false);
    const [row] = await sql`
      select status from assistant_pending_actions where token = ${pending.token}
    `;
    expect(row?.status).toBe("expired");
    const [p] = await sql`select stage from prospects where id = ${P1}`;
    expect(p?.stage).toBe("researching"); // unchanged by any of the above
  });

  it("direct-tier tools execute immediately through the loop", async () => {
    const reply = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "list prospects named Gate" },
        scripted([
          { action: "tool", tool: "list_prospects", input: { name: "Gate" } },
          { action: "answer", answer: "Found Gate Co." },
        ])
      )
    );
    expect(reply.pendingActions.length).toBe(0);
    expect(reply.toolCalls[0]!.ok).toBe(true);
    expect(reply.toolCalls[0]!.summary).toContain("Gate Co");
  });


  it("a wrong input shape gets the expected shape back and the corrected retry succeeds", async () => {
    const reply = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "show me Gate Co" },
        scripted([
          // Wrong shape first — the model's guess at the field name.
          { action: "tool", tool: "get_prospect", input: { id: P1 } },
          // The validation error names the expected shape; corrected retry.
          { action: "tool", tool: "get_prospect", input: { prospect_id: P1 } },
          { action: "answer", answer: "Found it after correcting my input." },
        ])
      )
    );
    expect(reply.toolCalls.length).toBe(2);
    expect(reply.toolCalls[0]!.ok).toBe(false);
    expect(reply.toolCalls[0]!.summary).toContain("Expected shape");
    expect(reply.toolCalls[0]!.summary).toContain('"prospect_id": uuid');
    expect(reply.toolCalls[1]!.ok).toBe(true);
  });

  it("spec 102: run_sense_check executes direct through the loop and reports the service's refusal honestly", async () => {
    // Gate Co has no approved primary finding, so the service refuses
    // before any LLM call — the loop must surface that, not fabricate.
    const reply = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "sense check Gate Co's audit" },
        scripted([
          { action: "tool", tool: "run_sense_check", input: { prospect_id: P1 } },
          { action: "answer", answer: "There is no audit content to check yet." },
        ])
      )
    );
    expect(reply.pendingActions.length).toBe(0); // direct tier — no confirm card
    expect(reply.toolCalls[0]!.ok).toBe(false);
    expect(reply.toolCalls[0]!.summary).toContain("No primary approved finding");
  });

  it("spec 103: the discovery review loop — list through the loop, approve through the gate", async () => {
    const [run] = await sql`
      insert into prospect_discovery_runs (launch_id, provider, status, started_by)
      values ('cccccccc-0000-4000-8000-000000000011', 'perplexity', 'completed', ${operator.id})
      returning id
    `;
    const [candidate] = await sql`
      insert into prospect_discovery_candidates
        (discovery_run_id, launch_id, business_name, payload, provider, source_type,
         source_url, retrieved_at, confidence, provenance)
      values (${run!.id}, 'cccccccc-0000-4000-8000-000000000011', 'Fresh Find Co',
        ${sql.json({ businessName: "Fresh Find Co" } as never)}, 'perplexity', 'search',
        'https://example.test/source', now(), 0.65, 'ai_inferred')
      returning id
    `;
    const candidateId = candidate!.id as string;

    // The list through the loop: compact rows, no raw payload.
    const reply = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "what discovery candidates are waiting?" },
        scripted([
          { action: "tool", tool: "list_discovery_candidates", input: {} },
          { action: "answer", answer: "One pending candidate." },
        ])
      )
    );
    expect(reply.toolCalls[0]!.ok).toBe(true);
    expect(reply.toolCalls[0]!.summary).toContain("Fresh Find Co");
    expect(reply.toolCalls[0]!.summary).not.toContain('"payload"');

    // Approve through the human gate; the prospect exists only after.
    const conversationId = await newConversation(operator);
    const pending = await confirm.mintPendingAction(
      operator,
      conversationId,
      "review_discovery_candidate",
      { candidate_id: candidateId, decision: "approve" }
    );
    let [row] = await sql`select status from prospect_discovery_candidates where id = ${candidateId}`;
    expect(row?.status).toBe("pending"); // minting executed nothing
    unwrap(await confirm.confirmAssistantAction(operator, { token: pending.token }));
    [row] = await sql`
      select status, created_prospect_id from prospect_discovery_candidates
      where id = ${candidateId}
    `;
    expect(row?.status).toBe("approved");
    const [prospect] = await sql`
      select business_name from prospects where id = ${row?.createdProspectId}
    `;
    expect(prospect?.businessName).toBe("Fresh Find Co");
  });

  it("spec 103: the enrichment review loop — list pending proposals, reject through the gate", async () => {
    const [proposal] = await sql`
      insert into enrichment_proposals
        (prospect_id, kind, payload, citations, confidence, model, agent_version, created_by)
      values (${P1}, 'contact_email',
        ${sql.json({ email: "wrong@person.example" } as never)},
        ${sql.json(["https://example.test/cite"] as never)}, 0.4, 'test', 'test-v1', ${operator.id})
      returning id
    `;
    const proposalId = proposal!.id as string;

    const reply = unwrap(
      await assistant.askAssistant(
        operator,
        { message: "what did enrichment find for Gate Co?" },
        scripted([
          { action: "tool", tool: "list_enrichment_proposals", input: { prospect_id: P1 } },
          { action: "answer", answer: "One low-confidence email proposal." },
        ])
      )
    );
    expect(reply.toolCalls[0]!.ok).toBe(true);
    expect(reply.toolCalls[0]!.summary).toContain("wrong@person.example");

    const conversationId = await newConversation(operator);
    const pending = await confirm.mintPendingAction(
      operator,
      conversationId,
      "reject_enrichment_proposal",
      { proposal_id: proposalId, reason: "Wrong person — different brokerage." }
    );
    unwrap(await confirm.confirmAssistantAction(operator, { token: pending.token }));
    const [row] = await sql`select status from enrichment_proposals where id = ${proposalId}`;
    expect(row?.status).toBe("rejected");
    const [audit] = await sql`
      select id from audit_log
      where action = 'prospect.enrichment_reject' and entity_id = ${proposalId}
    `;
    expect(audit).toBeDefined();
    // Rejected rows leave the review list.
    const { listEnrichmentProposals } = await import("@/lib/prospects/enrichment");
    expect((await listEnrichmentProposals(P1)).find((p) => p.id === proposalId)).toBeUndefined();
  });

  it("spec 104: cancel_run and retry_failed_cells execute only through the gate", async () => {
    await sql`insert into projects (id, name) values ('99999999-0000-4000-8000-000000000001', 'Run mgmt')`;
    await sql`insert into prompt_sets (id, project_id, name)
      values ('99999999-0000-4000-8000-000000000002', '99999999-0000-4000-8000-000000000001', 'set')`;
    await sql`insert into prompt_set_versions (id, prompt_set_id, version, frozen_prompts, frozen_by, frozen_at)
      values ('99999999-0000-4000-8000-000000000003', '99999999-0000-4000-8000-000000000002', 1,
        '[]'::jsonb, ${operator.id}, now())`;
    const providers = [{ provider: "mock", model: "mock-model", repetitions: 1 }];
    const seedRun = async (id: string, status: string) => sql`
      insert into runs (id, project_id, prompt_set_version_id, label, providers, trigger, budget_usd, status)
      values (${id}, '99999999-0000-4000-8000-000000000001', '99999999-0000-4000-8000-000000000003',
        ${"mgmt " + status}, ${sql.json(providers as never)}, 'manual', 1, ${status})
    `;
    const runningId = "99999999-0000-4000-8000-000000000011";
    const partialId = "99999999-0000-4000-8000-000000000012";
    await seedRun(runningId, "running");
    await seedRun(partialId, "partial");

    const conversationId = await newConversation(operator);
    const cancelPending = await confirm.mintPendingAction(operator, conversationId, "cancel_run", {
      run_id: runningId,
    });
    let [run] = await sql`select status from runs where id = ${runningId}`;
    expect(run?.status).toBe("running"); // minting executed nothing
    unwrap(await confirm.confirmAssistantAction(operator, { token: cancelPending.token }));
    [run] = await sql`select status, status_detail from runs where id = ${runningId}`;
    expect(run?.status).toBe("partial");
    expect(run?.statusDetail).toBe("cancelled");

    const retryPending = await confirm.mintPendingAction(
      operator,
      conversationId,
      "retry_failed_cells",
      { run_id: partialId }
    );
    unwrap(await confirm.confirmAssistantAction(operator, { token: retryPending.token }));
    [run] = await sql`select status from runs where id = ${partialId}`;
    expect(run?.status).toBe("pending");
    const [job] = await sql`
      select id from jobs where type = 'execute_run' and payload->>'runId' = ${partialId}
    `;
    expect(job).toBeDefined();
    // A still-executing run refuses retry through the same path.
    const bad = await confirm.mintPendingAction(operator, conversationId, "retry_failed_cells", {
      run_id: partialId,
    });
    const refused = unwrap(await confirm.confirmAssistantAction(operator, { token: bad.token }));
    expect((refused.result as { error?: string }).error).toMatch(/still executing/);
    [run] = await sql`select status from runs where id = ${partialId}`;
    expect(run?.status).toBe("pending"); // unchanged by the refused retry
  });

  it("a mint with invalid input refuses — a malformed proposal can never be confirmed later", async () => {
    const conversationId = await newConversation(operator);
    await expect(
      confirm.mintPendingAction(operator, conversationId, "send_draft", {
        draft_id: "not-a-uuid",
        business_purpose: "x",
      })
    ).rejects.toThrow(/Invalid input/);
  });
});

