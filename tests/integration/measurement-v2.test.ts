/**
 * Spec 151 milestone A, end to end over real Postgres: per-instrument
 * estimates, no provider-level blend, v1.1 rows untouched, frozen cohort
 * denominators, pinned instruments, immutability of the new tables.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "../helpers/db";
import { operatorUser } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("measurement v2 (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let scoring: typeof import("@/lib/scoring/compute");
  let measurement: typeof import("@/lib/measurement/service");
  let dbm: typeof import("@/db/measurement");
  const user = operatorUser();

  let projectId: string;
  let versionId: string;
  let subjectId: string;
  let rivalId: string;
  let outsiderId: string;

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    await truncateAll(sql);
    scoring = await import("@/lib/scoring/compute");
    measurement = await import("@/lib/measurement/service");
    dbm = await import("@/db/measurement");
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await truncateAll(sql);
    const [project] = await sql`insert into projects (name) values ('V2 Client') returning id`;
    projectId = project!.id as string;
    const [s] = await sql`insert into companies (name, domain) values ('Rivera Team', 'riverateam.com') returning id`;
    const [r] = await sql`insert into companies (name) values ('Meridian Group') returning id`;
    const [o] = await sql`insert into companies (name) values ('Outsider Realty') returning id`;
    subjectId = s!.id as string;
    rivalId = r!.id as string;
    outsiderId = o!.id as string;
    await sql`update projects set subject_company_id = ${subjectId} where id = ${projectId}`;
    await sql`insert into competitors (project_id, company_id, tier) values (${projectId}, ${rivalId}, 'primary')`;
    const [set] = await sql`insert into prompt_sets (project_id, name) values (${projectId}, 'Set') returning id`;
    const [version] = await sql`
      insert into prompt_set_versions (prompt_set_id, version, frozen_prompts)
      values (${set!.id}, 1, '[]') returning id
    `;
    versionId = version!.id as string;
  });

  /** A completed run: `prompts` × `reps` per instrument; the subject is
   * recommended on the first `hitPrompts` prompts of the FIRST instrument;
   * the outsider is mentioned on every answer. */
  async function seedRun(instruments: { provider: string; model: string }[], opts: { prompts: number; reps: number; hitPrompts: number }) {
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd)
      values (${projectId}, ${versionId}, 'run', ${sql.json(instruments.map((i) => ({ ...i, repetitions: opts.reps })) as never)},
        'completed', 'manual', 5)
      returning id
    `;
    const runId = run!.id as string;
    for (const [idx, inst] of instruments.entries()) {
      for (let p = 0; p < opts.prompts; p += 1) {
        const promptId = `00000000-0000-4000-8000-${String(p).padStart(12, "0")}`;
        for (let rep = 1; rep <= opts.reps; rep += 1) {
          const [resp] = await sql`
            insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition,
              raw_payload, response_text, request_params)
            values (${runId}, ${promptId}, ${`best agent in Springfield #${p}`}, ${inst.provider}, ${inst.model}, ${rep},
              ${sql.json({ model: `${inst.model}-served` })}, 'answer', ${sql.json({ sampling: "provider_default" })})
            returning id
          `;
          const responseId = resp!.id as string;
          if (idx === 0 && p < opts.hitPrompts) {
            await sql`
              insert into mentions (response_id, company_id, mentioned, recommended, parser_version, confidence)
              values (${responseId}, ${subjectId}, true, true, 'mention-parser-v2+llm', 0.95)
            `;
          }
          await sql`
            insert into mentions (response_id, company_id, mentioned, recommended, parser_version, confidence)
            values (${responseId}, ${outsiderId}, true, false, 'mention-parser-v2+llm', 0.95)
          `;
        }
      }
    }
    return runId;
  }

  it("writes per-instrument estimates and refuses the blended provider row", async () => {
    const runId = await seedRun(
      [
        { provider: "openai", model: "gpt-5.4-mini-2026-03-17+search" },
        { provider: "openai", model: "gpt-5.4-2026-03-05" },
        { provider: "perplexity", model: "sonar" },
      ],
      { prompts: 6, reps: 2, hitPrompts: 3 }
    );
    await scoring.computeScores(runId);

    const est = await dbm.estimatesForRun(runId, "v1.2");
    const subjectRec = est.filter((e) => e.companyId === subjectId && e.metric === "recommendation_rate");
    expect(subjectRec).toHaveLength(3);
    const mini = subjectRec.find((e) => e.model === "gpt-5.4-mini-2026-03-17+search");
    expect(mini).toMatchObject({ numerator: 6, denominator: 12, distinctPrompts: 6, rate: 0.5 });
    expect(mini?.servedModels).toEqual(["gpt-5.4-mini-2026-03-17+search-served"]);
    expect(mini?.wilsonLow).not.toBeNull();
    expect(mini?.clusteredLow).not.toBeNull();

    const providers = await sql`
      select distinct provider from scores_staging where run_id = ${runId} and scoring_version = 'v1.2'
    `;
    expect(providers.map((p) => p.provider).sort()).toEqual(["all", "perplexity"]);
  });

  it("never touches v1.1 rows and is idempotent", async () => {
    const runId = await seedRun([{ provider: "openai", model: "m1" }], { prompts: 5, reps: 2, hitPrompts: 2 });
    await sql`
      insert into scores (run_id, company_id, metric, provider, value, sample_size, scoring_version)
      values (${runId}, ${subjectId}, 'mention_rate', 'openai', 0.123456, 10, 'v1.1')
    `;
    const before = await sql`select * from scores where scoring_version = 'v1.1' and provider = 'openai' and metric = 'mention_rate' and company_id = ${subjectId}`;
    await scoring.computeScores(runId);
    await scoring.computeScores(runId);
    // The pre-existing v1.1 row is byte-identical (the legacy writer's own
    // row for the same key was a no-op: on conflict do nothing).
    const after = await sql`select * from scores where scoring_version = 'v1.1' and provider = 'openai' and metric = 'mention_rate' and company_id = ${subjectId}`;
    expect(after).toEqual(before);
    const [{ n }] = (await sql`select count(*)::int as n from score_estimates where run_id = ${runId}`) as unknown as [{ n: number }];
    const [{ m }] = (await sql`select count(distinct (company_id, metric, instrument_key))::int as m from score_estimates where run_id = ${runId}`) as unknown as [{ m: number }];
    expect(n).toBe(m);
  });

  it("a frozen cohort keeps registry growth out of share-of-voice", async () => {
    const before = await seedRun([{ provider: "openai", model: "m1" }], { prompts: 5, reps: 1, hitPrompts: 5 });
    await scoring.computeScores(before);
    const sovOpen = (await dbm.estimatesForRun(before, "v1.2")).find(
      (e) => e.companyId === subjectId && e.metric === "share_of_voice"
    );
    // Without a cohort the outsider (global registry) is in the denominator.
    expect(sovOpen).toMatchObject({ numerator: 5, denominator: 10, cohortId: null });

    const frozen = await measurement.freezeCompetitorCohort(user, { projectId, reason: "baseline" });
    expect(frozen.ok).toBe(true);
    const again = await measurement.freezeCompetitorCohort(user, { projectId, reason: "no change" });
    expect(again.ok && frozen.ok && again.data.version === frozen.data.version).toBe(true);

    const after = await seedRun([{ provider: "openai", model: "m1" }], { prompts: 5, reps: 1, hitPrompts: 5 });
    await scoring.computeScores(after);
    const est = await dbm.estimatesForRun(after, "v1.2");
    const sov = est.find((e) => e.companyId === subjectId && e.metric === "share_of_voice");
    expect(sov).toMatchObject({ numerator: 5, denominator: 5, rate: 1 });
    expect(sov?.cohortId).toBe(frozen.ok ? frozen.data.cohortId : null);
    expect(est.some((e) => e.companyId === outsiderId)).toBe(false);
  });

  it("pins the default instrument once and reuses it", async () => {
    const first = await measurement.ensurePinnedInstrument(projectId, user.id);
    const second = await measurement.ensurePinnedInstrument(projectId, user.id);
    expect(second.id).toBe(first.id);
    expect(first.providers.map((p) => p.model)).toEqual(["gpt-5.4-mini-2026-03-17+search", "sonar"]);
    const repinned = await measurement.pinMeasurementInstrument(user, {
      projectId,
      providers: [{ provider: "openai", model: "gpt-5.4-2026-03-05", repetitions: 6 }],
      reason: "client asked for the frontier model",
    });
    expect(repinned.ok && repinned.data.version).toBe(2);
  });

  it("an existing project's first pin copies ITS own last completed run, not the default (review M5)", async () => {
    await seedRun([{ provider: "openai", model: "gpt-5.4-2026-03-05" }], { prompts: 5, reps: 1, hitPrompts: 1 });
    const pinned = await measurement.ensurePinnedInstrument(projectId, user.id);
    expect(pinned.providers.map((p) => p.model)).toEqual(["gpt-5.4-2026-03-05"]);
    expect(pinned.reason).toMatch(/copied from this project/);
  });

  it("rescoring uses the cohort in force when the run started, not a later one (review H4)", async () => {
    const early = await seedRun([{ provider: "openai", model: "m1" }], { prompts: 5, reps: 1, hitPrompts: 5 });
    await sql`update runs set started_at = now() - interval '10 days' where id = ${early}`;
    await measurement.freezeCompetitorCohort(user, { projectId, reason: "frozen after the early run" });
    await scoring.computeScores(early);
    const sov = (await dbm.estimatesForRun(early, "v1.2")).find((e) => e.companyId === subjectId && e.metric === "share_of_voice");
    expect(sov).toMatchObject({ cohortId: null, denominator: 10 });
  });

  it("new measurement tables are insert-only", async () => {
    const runId = await seedRun([{ provider: "openai", model: "m1" }], { prompts: 5, reps: 1, hitPrompts: 1 });
    await scoring.computeScores(runId);
    await expect(sql`update score_estimates set rate = 0 where run_id = ${runId}`).rejects.toThrow(/insert-only/);
    await measurement.freezeCompetitorCohort(user, { projectId, reason: "baseline" });
    await expect(sql`delete from competitor_cohorts where project_id = ${projectId}`).rejects.toThrow(/insert-only/);
    await measurement.ensurePinnedInstrument(projectId, user.id);
    await expect(sql`update measurement_instruments set reason = 'x'`).rejects.toThrow(/insert-only/);
  });
});
