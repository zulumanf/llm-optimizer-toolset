/**
 * Unified LLM cost ledger (spec 050). Every runAgent call — success or
 * terminal failure — writes an llm_calls row, so agent spend draws down the
 * same daily ceiling as benchmark runs instead of being computed and thrown
 * away. The ledger is insert-only: a spend record that can be edited is a
 * receipt, not a ledger.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { runAgent, type AgentCaller } from "@/lib/ai/agent";
import { CLASSIFIER_MODEL } from "@/lib/constants";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

const stubCaller =
  (text: string): AgentCaller =>
  async () => ({ text, tokensIn: 100, tokensOut: 50 });

describe.skipIf(!TEST_URL)("llm call ledger (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  it("records a successful agent call with cost, tokens, and attribution", async () => {
    await runAgent({
      agentVersion: "ledger-test-agent-v1",
      system: "s",
      user: "u",
      schema: z.object({ ok: z.boolean() }),
      model: CLASSIFIER_MODEL,
      purpose: "ledger_test",
      caller: stubCaller('{"ok": true}'),
    });
    const [row] = await sql`
      select * from llm_calls where agent_version = 'ledger-test-agent-v1'
    `;
    expect(row).toBeDefined();
    expect(row!.model).toBe(CLASSIFIER_MODEL);
    expect(row!.purpose).toBe("ledger_test");
    expect(row!.success).toBe(true);
    expect(Number(row!.attempts)).toBe(1);
    expect(Number(row!.tokensIn)).toBe(100);
    expect(Number(row!.tokensOut)).toBe(50);
    expect(Number(row!.costMicroUsd)).toBeGreaterThan(0);
  });

  it("records a terminally failed agent call — the spend still happened", async () => {
    await expect(
      runAgent({
        agentVersion: "ledger-test-failure-v1",
        system: "s",
        user: "u",
        schema: z.object({ ok: z.boolean() }),
        model: CLASSIFIER_MODEL,
        caller: stubCaller("not json at all"),
      })
    ).rejects.toThrow(/invalid output twice/);
    const [row] = await sql`
      select * from llm_calls where agent_version = 'ledger-test-failure-v1'
    `;
    expect(row).toBeDefined();
    expect(row!.success).toBe(false);
    expect(Number(row!.attempts)).toBe(2);
    // Two attempts' tokens accumulated
    expect(Number(row!.tokensIn)).toBe(200);
  });

  it("feeds the daily spend ceiling", async () => {
    const { spendLast24hUsd } = await import("@/db/runs");
    const spent = await spendLast24hUsd();
    // Two calls above, each priced > 0 — agent spend is no longer invisible.
    expect(spent).toBeGreaterThan(0);
  });

  it("is insert-only", async () => {
    await expect(
      sql`update llm_calls set cost_micro_usd = 0
        where agent_version = 'ledger-test-agent-v1'`
    ).rejects.toThrow(/insert-only/);
    await expect(
      sql`delete from llm_calls where agent_version = 'ledger-test-agent-v1'`
    ).rejects.toThrow(/insert-only/);
  });
});
