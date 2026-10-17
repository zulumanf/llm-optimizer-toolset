/**
 * Release 151: backward-compatible scoring cutover.
 *  - before the cutover `scores` holds v1.1 ONLY (pre-151 images stay safe);
 *    v1.2 accumulates in scores_staging;
 *  - the cutover copies staging → scores and flips readers atomically,
 *    under a lock no scoring write can straddle;
 *  - interrupted/resumed rescoring, partial runs, archived entities and
 *    inconsistent rows are handled explicitly; rollback restores readers.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("scoring cutover (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let scoring: typeof import("@/lib/scoring/compute");
  let cutover: typeof import("@/lib/scoring/cutover");
  let dashboard: typeof import("@/db/dashboard");
  let projectId: string;
  let subjectId: string;
  let versionId: string;

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    scoring = await import("@/lib/scoring/compute");
    cutover = await import("@/lib/scoring/cutover");
    dashboard = await import("@/db/dashboard");
  });
  afterAll(async () => {
    await sql`update scoring_state set read_version = 'v1.1', write_legacy = true where id = 1`;
    await sql.end();
  });

  beforeEach(async () => {
    await truncateAll(sql);
    const [project] = await sql`insert into projects (name) values ('Cutover') returning id`;
    projectId = project!.id as string;
    const [s] = await sql`insert into companies (name) values ('Rivera Team') returning id`;
    subjectId = s!.id as string;
    await sql`update projects set subject_company_id = ${subjectId} where id = ${projectId}`;
    const [set] = await sql`insert into prompt_sets (project_id, name) values (${projectId}, 'S') returning id`;
    const [v] = await sql`insert into prompt_set_versions (prompt_set_id, version, frozen_prompts) values (${set!.id}, 1, '[]') returning id`;
    versionId = v!.id as string;
  });

  async function run(hits: number, opts: { status?: string; errors?: number } = {}): Promise<string> {
    const [r] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers, status, trigger, budget_usd)
      values (${projectId}, ${versionId}, 'r', '[]', ${opts.status ?? "completed"}, 'manual', 1) returning id
    `;
    for (let p = 0; p < 6; p += 1) {
      const failed = p < (opts.errors ?? 0);
      const [resp] = await sql`
        insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition, response_text, error)
        values (${r!.id}, gen_random_uuid(), 'best agent?', 'openai', 'm1', 1, 'a',
          ${failed ? sql.json({ kind: "provider", message: "x" }) : null}) returning id
      `;
      if (!failed && p < hits) {
        await sql`
          insert into mentions (response_id, company_id, mentioned, recommended, parser_version, confidence)
          values (${resp!.id}, ${subjectId}, true, true, 'mention-parser-v2+llm', 0.9)
        `;
      }
    }
    return r!.id as string;
  }

  const versionsIn = async (table: "scores" | "scores_staging", runId: string) =>
    (await sql`select distinct scoring_version from ${sql(table)} where run_id = ${runId} order by 1`).map((v) => v.scoringVersion);

  it("before cutover `scores` stays v1.1-only (pre-151 compatible); the flip copies staging and readers switch atomically", async () => {
    const old = await run(3);
    await sql`
      insert into scores (run_id, company_id, metric, provider, value, sample_size, scoring_version)
      values (${old}, ${subjectId}, 'recommendation_rate', 'all', 0.5, 6, 'v1.1'),
             (${old}, ${subjectId}, 'authority_score', 'all', 40, 6, 'v1.1')
    `;
    const fresh = await run(6);
    await scoring.computeScores(fresh);
    expect(await versionsIn("scores", fresh)).toEqual(["v1.1"]);
    expect(await versionsIn("scores_staging", fresh)).toEqual(["v1.2"]);

    const before = await dashboard.authorityTrend(projectId);
    expect([...new Set(before.map((p) => p.runId))].sort()).toEqual([old, fresh].sort());
    expect(new Set(before.map((p) => p.scoringVersion))).toEqual(new Set(["v1.1"]));

    let v = await cutover.verifyCutover();
    expect(v.runsMissingV12Scores).toEqual([old]);
    expect((await cutover.applyCutover({ reason: "t", changedBy: "t" })).applied).toBe(false);

    await scoring.computeScores(old, { publishMovement: false, writeLegacy: false });
    expect(await versionsIn("scores", old)).toEqual(["v1.1"]); // rescore never touches scores pre-cutover
    v = await cutover.verifyCutover();
    expect(v.runsMissingV12Scores).toEqual([]);
    const applied = await cutover.applyCutover({ reason: "verified", changedBy: "t", acceptDifferences: true });
    expect(applied.applied).toBe(true);
    expect(applied.copiedRows).toBeGreaterThan(0);
    expect(await versionsIn("scores", fresh)).toEqual(["v1.1", "v1.2"]);

    const after = await dashboard.authorityTrend(projectId);
    expect([...new Set(after.map((p) => p.runId))].sort()).toEqual([old, fresh].sort());
    expect(new Set(after.map((p) => p.scoringVersion))).toEqual(new Set(["v1.2"]));

    // After the flip, new runs write v1.2 straight into scores too.
    const later = await run(2);
    await scoring.computeScores(later);
    expect(await versionsIn("scores", later)).toEqual(["v1.1", "v1.2"]);

    await cutover.rollbackCutover("drill", "t");
    const back = await dashboard.authorityTrend(projectId);
    expect(new Set(back.map((p) => p.scoringVersion))).toEqual(new Set(["v1.1"]));
    expect([...new Set(back.map((p) => p.runId))].sort()).toEqual([old, fresh, later].sort());
    await expect(sql`delete from scores_staging`).rejects.toThrow(/insert-only/);
  });

  it("an interrupted rescore resumes idempotently; partial and error-only runs are handled", async () => {
    const runs = [await run(2), await run(4), await run(1, { status: "partial", errors: 3 })];
    const errorOnly = await run(0, { errors: 6 });
    for (const r of [...runs, errorOnly]) await scoring.computeScores(r, { writeLegacy: true });
    // Simulate a production history that only has v1.1: keep v1.1, then
    // pretend the rescore crashed after the first run.
    await sql.unsafe("truncate scores_staging, score_estimates");
    await scoring.computeScores(runs[0]!, { writeLegacy: false });
    let v = await cutover.verifyCutover();
    expect(v.runsMissingV12Scores.sort()).toEqual([runs[1]!, runs[2]!].sort());
    // Resume twice (idempotent: no duplicate rows, no errors).
    for (let i = 0; i < 2; i += 1) for (const r of runs) await scoring.computeScores(r, { writeLegacy: false });
    v = await cutover.verifyCutover();
    expect(v.ok).toBe(true);
    const [{ n, d }] = (await sql`
      select count(*)::int as n, count(distinct (run_id, company_id, metric, provider, scoring_version))::int as d from scores_staging
    `) as unknown as [{ n: number; d: number }];
    expect(n).toBe(d);
    // The error-only run has no valid answers: no rows in either version, not "missing".
    expect(await versionsIn("scores", errorOnly)).toEqual([]);
    expect(v.runsMissingV12Scores).not.toContain(errorOnly);
  });

  it("an archived entity and an inconsistent historical row are reported, not hidden", async () => {
    const r = await run(4);
    await scoring.computeScores(r);
    // An entity archived after v1.1 was written: v1.2 rescoring will not score it.
    const [gone] = await sql`insert into companies (name) values ('Archived Co') returning id`;
    await sql`
      insert into scores (run_id, company_id, metric, provider, value, sample_size, scoring_version)
      values (${r}, ${gone!.id}, 'mention_rate', 'openai', 0.25, 6, 'v1.1')
    `;
    await sql`update companies set archived_at = now() where id = ${gone!.id}`;
    // An inconsistent historical v1.1 provider row (stale relative to the data).
    const r2 = await run(3);
    await sql`
      insert into scores (run_id, company_id, metric, provider, value, sample_size, scoring_version)
      values (${r2}, ${subjectId}, 'mention_rate', 'openai', 0.9, 6, 'v1.1')
    `;
    await scoring.computeScores(r2, { writeLegacy: false });
    const v = await cutover.verifyCutover();
    expect(v.runsMissingV12Scores).toEqual([]); // coverage is per run
    expect(v.parityDifferences).toEqual([
      expect.objectContaining({ runId: r2, metric: "mention_rate", provider: "openai", v11: 0.9, v12: 0.5 }),
    ]);
    const refused = await cutover.applyCutover({ reason: "t", changedBy: "t" });
    expect(refused.applied).toBe(false);
    expect(refused.refusal).toMatch(/parity/);
  });

  it("the flip waits for an in-flight scoring transaction and never splits a run across versions", async () => {
    const r = await run(5);
    await scoring.computeScores(r, { writeLegacy: true });
    // Hold the shared scoring lock as an in-flight writer would.
    const holder = await sql.reserve();
    await holder`begin`;
    await holder`select pg_advisory_xact_lock_shared(727274152)`;
    let flipped = false;
    const flip = cutover.applyCutover({ reason: "race", changedBy: "t", acceptDifferences: true }).then((x) => {
      flipped = x.applied;
    });
    await new Promise((res) => setTimeout(res, 300));
    expect(flipped).toBe(false);
    const [mid] = await sql`select read_version from scoring_state`;
    expect(mid?.readVersion).toBe("v1.1");
    await holder`commit`;
    holder.release();
    await flip;
    expect(flipped).toBe(true);
  });

  it("legacy writer cannot be retired while readers use v1.1, and rollback refuses after retirement", async () => {
    await expect(cutover.retireLegacyWriter("x", "t")).rejects.toThrow(/flip the read version/);
    await sql`update scoring_state set read_version = 'v1.2'`;
    await cutover.retireLegacyWriter("held two weeks", "t");
    await expect(cutover.rollbackCutover("x", "t")).rejects.toThrow(/retired/);
    await expect(sql`update scoring_state set read_version = 'v1.1'`).rejects.toThrow();
  });
});
