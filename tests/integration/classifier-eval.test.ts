/**
 * Spec 050: the gold-set eval harness measures the PRODUCTION classifier
 * path (classifyResponseLlm) with pure metric math and persists every
 * evaluation, and the review queue's human verdicts become a measured
 * disagreement rate instead of a discarded gold label.
 *
 * Stub callers keep CI deterministic and keyless; the metric math they
 * exercise is exactly what scripts/eval-classifier.ts runs live.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentCaller } from "@/lib/ai/agent";
import type { GoldCase } from "@/lib/accuracy/classifier-gold";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const CO_A = "00000000-0000-4000-9000-0000000000a1";
const CO_B = "00000000-0000-4000-9000-0000000000b2";

/** Two-case corpus with exactly known counts. */
const MINI_CASES: GoldCase[] = [
  {
    id: "mini-recommended",
    promptText: "Best teams?",
    responseText: "I recommend Alpha Team. Beta Group is also active locally.",
    companies: [
      { id: CO_A, name: "Alpha Team", aliases: [], domain: null },
      { id: CO_B, name: "Beta Group", aliases: [], domain: null },
    ],
    expected: [
      { companyId: CO_A, mentioned: true, recommended: true },
      { companyId: CO_B, mentioned: true, recommended: false },
    ],
  },
  {
    id: "mini-trap",
    promptText: "Tell me about Alpha Team the esports org.",
    responseText: "Alpha Team is a well-known esports organisation, not a realtor.",
    companies: [{ id: CO_A, name: "Alpha Team", aliases: [], domain: null }],
    expected: [{ companyId: CO_A, mentioned: false, recommended: false, trap: true }],
  },
];

/** Answers per candidate from a fixed verdict table — a perfect oracle. */
const oracle =
  (verdicts: Record<string, { isSameEntity: boolean; mentioned: boolean; recommended: boolean }>): AgentCaller =>
  async ({ user }) => {
    const ids = [...user.matchAll(/- companyId: ([0-9a-f-]{36})/g)].map((m) => m[1] as string);
    // The prompt embeds the answer text; disambiguate the trap case by its text.
    const isTrap = user.includes("esports");
    return {
      text: JSON.stringify({
        companies: ids.map((id) => {
          const v = isTrap
            ? { isSameEntity: false, mentioned: false, recommended: false }
            : verdicts[id]!;
          return {
            companyId: id,
            isSameEntity: v.isSameEntity,
            mentioned: v.mentioned,
            recommended: v.recommended,
            listPosition: null,
            sentiment: "neutral",
            excerpt: null,
            confidence: 0.95,
          };
        }),
      }),
      tokensIn: 50,
      tokensOut: 30,
    };
  };

/** Says yes to everything — the naive classifier the floors must fail. */
const allPositive: AgentCaller = async ({ user }) => {
  const ids = [...user.matchAll(/- companyId: ([0-9a-f-]{36})/g)].map((m) => m[1] as string);
  return {
    text: JSON.stringify({
      companies: ids.map((id) => ({
        companyId: id,
        isSameEntity: true,
        mentioned: true,
        recommended: true,
        listPosition: null,
        sentiment: "positive",
        excerpt: null,
        confidence: 0.95,
      })),
    }),
    tokensIn: 50,
    tokensOut: 30,
  };
};

describe.skipIf(!TEST_URL)("classifier gold-set eval (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let evalMod: typeof import("@/lib/accuracy/classifier-eval");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    evalMod = await import("@/lib/accuracy/classifier-eval");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("a perfect oracle scores 1.0 across the board and passes", async () => {
    const result = await evalMod.evaluateClassifier({
      mode: "stub",
      cases: MINI_CASES,
      caller: oracle({
        [CO_A]: { isSameEntity: true, mentioned: true, recommended: true },
        [CO_B]: { isSameEntity: true, mentioned: true, recommended: false },
      }),
    });
    expect(result.precisionMentioned).toBe(1);
    expect(result.recallMentioned).toBe(1);
    expect(result.precisionRecommended).toBe(1);
    expect(result.recallRecommended).toBe(1);
    expect(result.entityRejectionAccuracy).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it("an all-positive classifier fails the floors with exact known metrics", async () => {
    const result = await evalMod.evaluateClassifier({
      mode: "stub",
      cases: MINI_CASES,
      caller: allPositive,
    });
    // 3 pairs; predictions: all 3 mentioned+recommended.
    // mentioned: TP=2 (case 1), FP=1 (trap) → P=2/3; FN=0 → R=1.
    expect(result.pairsTotal).toBe(3);
    expect(result.precisionMentioned).toBeCloseTo(2 / 3, 3);
    expect(result.recallMentioned).toBe(1);
    // recommended: expected true only for CO_A in case 1 → TP=1, FP=2 → P=1/3.
    expect(result.precisionRecommended).toBeCloseTo(1 / 3, 3);
    expect(result.recallRecommended).toBe(1);
    // The one trap was accepted → 0 rejection accuracy.
    expect(result.entityRejectionAccuracy).toBe(0);
    expect(result.passed).toBe(false);
    // Failures name the trap and the over-recommendations.
    expect(result.failures).toContainEqual({
      caseId: "mini-trap",
      companyId: CO_A,
      field: "mentioned",
      expected: false,
      actual: true,
    });
  });

  it("persists every evaluation to the insert-only ledger", async () => {
    const rows = await sql`
      select gold_set_version, mode, passed from classifier_evaluations
      order by evaluated_at asc
    `;
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.every((r) => r.mode === "stub")).toBe(true);
    await expect(
      sql`delete from classifier_evaluations`
    ).rejects.toThrow(/insert-only/);
  });

  it("runs the real gold corpus through the harness (stub caller)", async () => {
    // The shipped corpus has traps by construction, so a yes-to-everything
    // classifier must fail it — proving the corpus can catch a bad
    // instrument, not just decorate the repo.
    const result = await evalMod.evaluateClassifier({
      mode: "stub",
      caller: allPositive,
    });
    expect(result.casesTotal).toBeGreaterThanOrEqual(10);
    expect(result.passed).toBe(false);
    expect(result.entityRejectionAccuracy).not.toBeNull();
    expect(result.entityRejectionAccuracy!).toBeLessThan(0.9);
  });

  it("measures the review queue's human-vs-machine disagreement rate", async () => {
    const { classifierDisagreementRate } = await import(
      "@/lib/accuracy/disagreement"
    );
    // Minimal chain: project → set → version → run → response → company
    const [project] = await sql`
      insert into projects (name) values ('Disagreement Test') returning id
    `;
    const [set] = await sql`
      insert into prompt_sets (project_id, name)
      values (${project!.id}, 'set') returning id
    `;
    const [version] = await sql`
      insert into prompt_set_versions (prompt_set_id, version, frozen_prompts)
      values (${set!.id}, 1, '[]') returning id
    `;
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers,
        trigger, budget_usd)
      values (${project!.id}, ${version!.id}, 'r', '[]', 'manual', 1)
      returning id
    `;
    const [response] = await sql`
      insert into responses (run_id, prompt_id, prompt_text, provider, model,
        repetition, response_text)
      values (${run!.id}, gen_random_uuid(), 'p', 'mock', 'mock-model', 1, 'x')
      returning id
    `;
    const [company] = await sql`
      insert into companies (name) values ('Disagreement Co') returning id
    `;
    const reviewer = "00000000-0000-4000-8000-0000000000ee";
    // Machine said mentioned+recommended (rev 1); human overturned (rev 2).
    await sql`
      insert into mentions (response_id, company_id, revision, mentioned,
        recommended, parser_version, confidence, needs_review)
      values (${response!.id}, ${company!.id}, 1, true, true, 'v-test', 0.6, true)
    `;
    await sql`
      insert into mentions (response_id, company_id, revision, mentioned,
        recommended, parser_version, confidence, needs_review, reviewed_by,
        reviewed_at)
      values (${response!.id}, ${company!.id}, 2, false, false, 'v-test', 1.0,
        false, ${reviewer}, now())
    `;
    // A second reviewed pair where the human AGREED.
    const [response2] = await sql`
      insert into responses (run_id, prompt_id, prompt_text, provider, model,
        repetition, response_text)
      values (${run!.id}, gen_random_uuid(), 'p2', 'mock', 'mock-model', 1, 'y')
      returning id
    `;
    await sql`
      insert into mentions (response_id, company_id, revision, mentioned,
        recommended, parser_version, confidence, needs_review)
      values (${response2!.id}, ${company!.id}, 1, true, false, 'v-test', 0.6, true)
    `;
    await sql`
      insert into mentions (response_id, company_id, revision, mentioned,
        recommended, parser_version, confidence, needs_review, reviewed_by,
        reviewed_at)
      values (${response2!.id}, ${company!.id}, 2, true, false, 'v-test', 1.0,
        false, ${reviewer}, now())
    `;

    const report = await classifierDisagreementRate(30);
    expect(report.reviewed).toBe(2);
    expect(report.overturned).toBe(1);
    expect(report.disagreementRate).toBe(0.5);
    expect(report.mentionedOverturned).toBe(1);
    expect(report.recommendedOverturned).toBe(1);
  });

  it("returns null (not 0%) when nothing was reviewed in the window", async () => {
    const { classifierDisagreementRate } = await import(
      "@/lib/accuracy/disagreement"
    );
    const report = await classifierDisagreementRate(0);
    expect(report.reviewed).toBe(0);
    expect(report.disagreementRate).toBeNull();
  });
});
