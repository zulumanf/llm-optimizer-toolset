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
