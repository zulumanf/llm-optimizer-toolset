/**
 * A6 (pilot-launch-plan): dashboard and competitor reads must never blend
 * scoring versions. The scores unique key deliberately includes
 * scoring_version so old rows survive a methodology change — which means
 * every read that compares runs has to pin the version, or a trend line
 * quietly mixes v1.0 and v1.1 numbers: the exact cross-version comparison
 * lib/constants.ts forbids.
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SCORING_VERSION } from "@/lib/constants";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");
const OLD_VERSION = "v1.0";

describe.skipIf(!TEST_URL)("scoring-version hygiene (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let dashboard: typeof import("@/db/dashboard");
  let competitors: typeof import("@/db/competitors");

  let projectId: string;
  let subjectId: string;
  let competitorId: string;

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    dashboard = await import("@/db/dashboard");
    competitors = await import("@/db/competitors");

    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, { cwd: ROOT, stdio: "pipe" });
  });

  beforeEach(async () => {
    await sql.unsafe("truncate scores, runs, prompt_set_versions, prompt_sets, competitors, companies, projects cascade");

    const [project] = await sql`
      insert into projects (name) values ('Version hygiene') returning id
    `;
    projectId = project!.id as string;
    const [subject] = await sql`
      insert into companies (name) values ('Subject Co') returning id
    `;
    subjectId = subject!.id as string;
    const [competitor] = await sql`
      insert into companies (name) values ('Rival Co') returning id
    `;
    competitorId = competitor!.id as string;
    await sql`update projects set subject_company_id = ${subjectId} where id = ${projectId}`;
  });

  afterAll(async () => {
    await sql.end();
  });

  /** A scored run at `daysAgo`, with authority + recommendation rows for the
   * subject (and optionally the competitor) under the given version. */
  async function scoredRun(args: {
    daysAgo: number;
    version: string;
    authority: number;
    includeCompetitor?: boolean;
  }): Promise<string> {
    const [set] = await sql`
      insert into prompt_sets (project_id, name)
      values (${projectId}, ${`set-${args.daysAgo}-${args.version}`}) returning id
    `;
    const [version] = await sql`
      insert into prompt_set_versions (prompt_set_id, version, frozen_prompts)
      values (${set!.id}, 1, '[]') returning id
    `;
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers,
        status, trigger, budget_usd, started_at)
      values (${projectId}, ${version!.id}, ${`run-${args.daysAgo}`}, '[]',
        'completed', 'manual', 5, now() - make_interval(days => ${args.daysAgo}))
      returning id
    `;
    const runId = run!.id as string;
    const companies = args.includeCompetitor ? [subjectId, competitorId] : [subjectId];
    for (const companyId of companies) {
      await sql`
        insert into scores (run_id, company_id, metric, provider, value,
          sample_size, scoring_version)
        values
          (${runId}, ${companyId}, 'authority_score', 'all', ${args.authority}, 20, ${args.version}),
          (${runId}, ${companyId}, 'recommendation_rate', 'all', 0.4, 20, ${args.version})
      `;
    }
    return runId;
  }

  it("authorityTrend returns only current-version points, never a blended line", async () => {
    await scoredRun({ daysAgo: 21, version: OLD_VERSION, authority: 30 });
    await scoredRun({ daysAgo: 14, version: SCORING_VERSION, authority: 50 });
    await scoredRun({ daysAgo: 7, version: SCORING_VERSION, authority: 55 });

    const trend = await dashboard.authorityTrend(projectId);
    expect(trend.length).toBe(2);
    expect(trend.every((p) => p.scoringVersion === SCORING_VERSION)).toBe(true);
    expect(trend.map((p) => Number(p.value))).toEqual([50, 55]);
  });

  it("selfTiles compares a run to its predecessor under the SAME version", async () => {
    // Latest current-version run and its predecessor, with an old-version run
    // in between that must not become the delta baseline.
    await scoredRun({ daysAgo: 21, version: SCORING_VERSION, authority: 40 });
    await scoredRun({ daysAgo: 14, version: OLD_VERSION, authority: 90 });
    await scoredRun({ daysAgo: 7, version: SCORING_VERSION, authority: 55 });

    const tiles = await dashboard.selfTiles(projectId);
    const authority = tiles.find((t) => t.metric === "authority_score");
    expect(authority?.value).toBe(55);
    // Previous = the v-current run from 21 days ago — NOT the v1.0 row of 90.
    expect(authority?.previousValue).toBe(40);
  });

  it("latestScoresByCompany skips a newer run that only has old-version scores", async () => {
    await scoredRun({
      daysAgo: 14,
      version: SCORING_VERSION,
      authority: 50,
      includeCompetitor: true,
    });
    await scoredRun({ daysAgo: 7, version: OLD_VERSION, authority: 95 });

    const byCompany = await competitors.latestScoresByCompany(projectId);
    expect(byCompany.get(subjectId)?.authority_score).toBe(50);
    expect(byCompany.get(competitorId)?.authority_score).toBe(50);
  });
});
