/** Spec 151 A11: blind annotation, adjudication, and the gold report. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "../helpers/db";
import { adminUser, operatorUser } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("gold annotations (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let gold: typeof import("@/lib/evaluation/gold");
  const a = operatorUser();
  const b = adminUser();

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    gold = await import("@/lib/evaluation/gold");
  });
  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await truncateAll(sql);
    const [project] = await sql`insert into projects (name) values ('Gold') returning id`;
    const [company] = await sql`insert into companies (name) values ('Rivera Team') returning id`;
    const [set] = await sql`insert into prompt_sets (project_id, name) values (${project!.id}, 'S') returning id`;
    const [version] = await sql`insert into prompt_set_versions (prompt_set_id, version, frozen_prompts) values (${set!.id}, 1, '[]') returning id`;
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd)
      values (${project!.id}, ${version!.id}, 'r', '[]', 'completed', 'manual', 1) returning id
    `;
    for (let i = 0; i < 30; i += 1) {
      const provider = i % 2 === 0 ? "openai" : "perplexity";
      const [resp] = await sql`
        insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition, response_text)
        values (${run!.id}, gen_random_uuid(), 'best agent?', ${provider}, 'm', 1, ${`Answer ${i} mentions Rivera Team`})
        returning id
      `;
      await sql`
        insert into mentions (response_id, company_id, mentioned, recommended, parser_version, confidence)
        values (${resp!.id}, ${company!.id}, ${i % 3 !== 0}, ${i % 3 === 1}, 'mention-parser-v2+llm', 0.9)
      `;
    }
    // A mock capture must never be sampled.
    const [mock] = await sql`
      insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition, response_text)
      values (${run!.id}, gen_random_uuid(), 'q', 'mock', 'mock-model', 1, 'x') returning id
    `;
    await sql`
      insert into mentions (response_id, company_id, mentioned, recommended, parser_version, confidence)
      values (${mock!.id}, ${company!.id}, true, true, 'mention-parser-v2+llm', 0.9)
    `;
  });

  it("samples reproducibly by seed and stratifies real answers only", async () => {
    const one = await gold.createGoldSample(a, { name: "Sample one", size: 20, seed: 7 });
    const two = await gold.createGoldSample(a, { name: "Sample two", size: 20, seed: 7 });
    expect(one.ok && two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.data.strata).toEqual(two.data.strata);
    expect(Object.keys(one.data.strata).some((s) => s.startsWith("mock"))).toBe(false);
    const order = async (id: string) =>
      (await sql`select response_id from gold_sample_items where sample_id = ${id} order by position`).map((r) => r.responseId);
    expect(await order(one.data.sampleId)).toEqual(await order(two.data.sampleId));
  });

  it("annotation is blind and immutable; adjudication only for disputes; report counts only validated pairs", async () => {
    const sample = await gold.createGoldSample(a, { name: "Blind", size: 20, seed: 1 });
    if (!sample.ok) throw new Error(sample.error.message);
    const first = await gold.nextItemForAnnotator(sample.data.sampleId, a.id);
    expect(first).not.toBeNull();
    expect(Object.keys(first ?? {})).not.toContain("classifier");

    // Both annotators label everything "mentioned + recommended", except b
    // disagrees on the first item.
    for (const user of [a, b]) {
      for (;;) {
        const item = await gold.nextItemForAnnotator(sample.data.sampleId, user.id);
        if (!item) break;
        const disagree = user === b && item.itemId === first?.itemId;
        const res = await gold.recordAnnotation(user, {
          itemId: item.itemId,
          sameEntity: true,
          mentioned: true,
          recommended: !disagree,
        });
        expect(res.ok).toBe(true);
      }
    }
    const dup = await gold.recordAnnotation(a, { itemId: first!.itemId, sameEntity: true, mentioned: true, recommended: true });
    expect(dup.ok).toBe(false);

    let report = await gold.goldReport(sample.data.sampleId);
    expect(report.disputedItemIds).toEqual([first!.itemId]);
    expect(report.recommended.validatedPairs).toBe(19);
    expect(report.recommended.disputedPairs).toBe(1);

    const notDisputed = (await sql`select id from gold_sample_items where sample_id = ${sample.data.sampleId} and id <> ${first!.itemId} limit 1`)[0];
    const refused = await gold.adjudicateItem(a, { itemId: notDisputed!.id, sameEntity: true, mentioned: true, recommended: true, reason: "n/a" });
    expect(refused.ok).toBe(false);

    const adj = await gold.adjudicateItem(a, { itemId: first!.itemId, sameEntity: true, mentioned: true, recommended: false, reason: "hedged mention, not a recommendation" });
    expect(adj.ok).toBe(true);
    report = await gold.goldReport(sample.data.sampleId);
    expect(report.recommended.validatedPairs).toBe(20);
    expect(report.recommended.precision).not.toBeNull();
    await expect(sql`update gold_annotations set recommended = false`).rejects.toThrow(/insert-only/);
  });
});
