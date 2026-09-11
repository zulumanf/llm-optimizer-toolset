/**
 * Spec 060: the citation acquisition engine against real Postgres — ledger
 * aggregation → opportunities → ACVS from the seeded weight set → lifecycle →
 * presence checks flipping the gap component → placements as interventions.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000601",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("citation acquisition (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let svc: typeof import("@/lib/citations/service");

  let projectId: string;
  let subjectId: string;
  let rivalId: string;
  let versionId: string;
  let runId: string;
  const responseIds: string[] = [];

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    svc = await import("@/lib/citations/service");
    await seedTestActors(sql);

    const [project] = await sql`
      insert into projects (name) values ('Citation Test') returning id
    `;
    projectId = project!.id as string;
    // Deliberately NOT is_self: the subject must come from the project's
    // subject_company_id (the prospect-benchmark shape) — regression for the
    // metrics bug that resolved "the client" via the global flag.
    const [subject] = await sql`
      insert into companies (name, aliases, domain, is_self)
      values ('Lumina Group', '{Lumina}', 'lumina.example', false) returning id
    `;
    subjectId = subject!.id as string;
    const [rival] = await sql`
      insert into companies (name, aliases, domain)
      values ('Rival Realty', '{}', 'rival.example') returning id
    `;
    rivalId = rival!.id as string;
    await sql`
      update projects set subject_company_id = ${subjectId} where id = ${projectId}
    `;

    const [set] = await sql`
      insert into prompt_sets (project_id, name)
      values (${projectId}, 'Core') returning id
    `;
    const [highIntent] = await sql`
      insert into prompts (prompt_set_id, text, category, position, tier)
      values (${set!.id as string}, 'best brokerage in Jersey City', 'recommendation', 1, 1)
      returning id
    `;
    const [lowIntent] = await sql`
      insert into prompts (prompt_set_id, text, category, position, tier)
      values (${set!.id as string}, 'how do closings work', 'how-to', 2, 4)
      returning id
    `;
    const [version] = await sql`
      insert into prompt_set_versions (prompt_set_id, version, frozen_prompts)
      values (${set!.id as string}, 1, '[]') returning id
    `;
    versionId = version!.id as string;
    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers,
        status, trigger, budget_usd)
      values (${projectId}, ${versionId}, 'baseline', '[{"provider":"openai"}]',
        'completed', 'manual', 1)
      returning id
    `;
    runId = run!.id as string;

    // Four responses: two engines × two prompts; one is a mock (excluded).
    const specs = [
      { prompt: highIntent!.id as string, provider: "openai" },
      { prompt: highIntent!.id as string, provider: "anthropic" },
      { prompt: lowIntent!.id as string, provider: "openai" },
      { prompt: highIntent!.id as string, provider: "mock" },
    ];
    for (const [i, spec] of specs.entries()) {
      const [r] = await sql`
        insert into responses (run_id, prompt_id, prompt_text, provider, model,
          repetition, response_text)
        values (${runId}, ${spec.prompt}, 'p', ${spec.provider}, 'm', ${i + 1},
          'Rival Realty is often recommended; see localnews.example.')
        returning id
      `;
      responseIds.push(r!.id as string);
    }
    // The third-party domain: cited by responses 0 and 1 (both engines,
    // high-intent prompt) with URL variants that normalize to one domain.
    await sql`
      insert into response_citations (response_id, url, domain, kind) values
      (${responseIds[0]!}, 'https://localnews.example/story?utm_source=x', 'localnews.example', 'in_text'),
      (${responseIds[1]!}, 'https://localnews.example/other', 'localnews.example', 'search'),
      (${responseIds[3]!}, 'https://mockonly.example/x', 'mockonly.example', 'in_text')
    `;
    // Owned + competitor domains in the ledger — never acquisition targets.
    // blog.lumina.example is the subdomain regression: owner by suffix, not
    // stamped with company_id, and it must still never be minted.
    await sql`
      insert into response_citations (response_id, url, domain, kind, company_id) values
      (${responseIds[0]!}, 'https://lumina.example/about', 'lumina.example', 'in_text', ${subjectId}),
      (${responseIds[2]!}, 'https://rival.example/team', 'rival.example', 'in_text', ${rivalId}),
      (${responseIds[2]!}, 'https://blog.lumina.example/post', 'blog.lumina.example', 'in_text', null)
    `;
    // Current-revision mention: the rival is recommended in a citing answer.
    await sql`
      insert into mentions (response_id, company_id, mentioned, recommended,
        parser_version, confidence)
      values (${responseIds[0]!}, ${rivalId}, true, true, 'test-v1', 0.9)
    `;
  }, 180_000);

  afterAll(async () => {
    await sql.end();
  });

  it("discovery mints third-party opportunities only, scored from the seeded weight set", async () => {
    const result = await svc.discoverOpportunities(user, { projectId });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.discovered).toBe(1);
    // lumina.example + rival.example (owner-attributed) and
    // blog.lumina.example (suffix match) were cited but filtered.
    expect(result.data.skippedExcluded).toBe(3);

    const rows = await sql`
      select * from citation_opportunities where project_id = ${projectId}
    `;
    expect(rows).toHaveLength(1);
    const opp = rows[0]!;
    expect(opp.domain).toBe("localnews.example");
    expect(opp.status).toBe("discovered");
    expect(opp.acvsVersion).toBe("acvs-v1");
    expect(opp.acvsWeightSetVersion).toBe(1);
    expect(Number(opp.acvs)).toBeGreaterThan(0);
    const components = opp.acvsComponents as Record<string, number | null>;
    // 2 citing of 3 non-mock responses; both engines of 2; high-intent share 1.
    expect(components.citationFrequency).toBeCloseTo(2 / 3);
    expect(components.crossEngine).toBeCloseTo(1);
    expect(components.commercialIntent).toBeCloseTo(1);
    expect(components.recommendationInfluence).toBeCloseTo(0.5);
    expect(components.clientGap).toBeNull(); // unchecked ≠ gap
    expect((opp.acvsExplanation as string[]).length).toBeGreaterThan(3);
  });

  it("re-discovery preserves operator fields and status", async () => {
    const updated = await svc.updateOpportunity(user, {
      opportunityId: (
        await sql`select id from citation_opportunities where project_id = ${projectId}`
      )[0]!.id as string,
      status: "qualified",
      acquisitionPath: "local_media",
      acquisitionDifficulty: "easy",
      notes: "Editor is reachable.",
    });
    expect(updated.ok).toBe(true);

    // QA fix: the edit itself rescores — no Discover click needed for the
    // score to agree with the row's own displayed path/difficulty.
    const [freshlyScored] = await sql`
      select acvs_components from citation_opportunities where project_id = ${projectId}
    `;
    expect(
      (freshlyScored!.acvsComponents as Record<string, number>).feasibility
    ).toBe(1);

    const again = await svc.discoverOpportunities(user, { projectId });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.data.discovered).toBe(0);
    const [opp] = await sql`
      select * from citation_opportunities where project_id = ${projectId}
    `;
    expect(opp!.status).toBe("qualified");
    expect(opp!.acquisitionPath).toBe("local_media");
    expect(opp!.notes).toBe("Editor is reachable.");
    // Feasibility now reflects the recorded path+difficulty.
    expect((opp!.acvsComponents as Record<string, number>).feasibility).toBe(1);
  });

  it("refuses invalid lifecycle jumps and audits valid ones", async () => {
    const [opp] = await sql`
      select id from citation_opportunities where project_id = ${projectId}
    `;
    const bad = await svc.updateOpportunity(user, {
      opportunityId: opp!.id as string,
      status: "successful", // outcome without measuring
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.message).toContain("Cannot move");

    // QA fix: `measuring` is linkPlacement's state, never a manual label —
    // reaching it by hand would strand the opportunity with no intervention.
    const manualMeasuring = await svc.updateOpportunity(user, {
      opportunityId: opp!.id as string,
      status: "measuring",
    });
    expect(manualMeasuring.ok).toBe(false);
    if (!manualMeasuring.ok) {
      expect(manualMeasuring.error.message).toContain("Link placement");
    }

    const audits = await sql`
      select count(*)::int as n from audit_log
      where action = 'citation_opportunity.update' and entity_id = ${opp!.id as string}
    `;
    expect(audits[0]!.n).toBe(1);
  });

  it("presence checks are append-only facts that flip the gap on rescore", async () => {
    const [opp] = await sql`
      select id, domain from citation_opportunities where project_id = ${projectId}
    `;
    const page = (body: string) =>
      (async () =>
        new Response(body, { status: 200 })) as unknown as typeof fetch;

    await svc.runPresenceCheck(
      {
        projectId,
        domain: opp!.domain as string,
        url: `https://${opp!.domain as string}/`,
        checkedBy: user.id,
      },
      { fetchImpl: page("<html><p>Rival Realty covers the market.</p></html>"), lookupImpl: null }
    );
    await svc.rescoreProject(projectId);
    let [scored] = await sql`
      select acvs_components from citation_opportunities where id = ${opp!.id as string}
    `;
    expect((scored!.acvsComponents as Record<string, number>).clientGap).toBe(1);

    await svc.runPresenceCheck(
      {
        projectId,
        domain: opp!.domain as string,
        url: `https://${opp!.domain as string}/`,
        checkedBy: user.id,
      },
      { fetchImpl: page("<html><p>Lumina Group and Rival Realty.</p></html>"), lookupImpl: null }
    );
    await svc.rescoreProject(projectId);
    [scored] = await sql`
      select acvs_components from citation_opportunities where id = ${opp!.id as string}
    `;
    expect((scored!.acvsComponents as Record<string, number>).clientGap).toBe(0);

    const checks = await sql`
      select client_present, competitor_hits from source_presence_checks
      where project_id = ${projectId} order by checked_at asc
    `;
    expect(checks).toHaveLength(2);
    expect(checks[0]!.clientPresent).toBe(false);
    expect(
      (checks[0]!.competitorHits as { name: string }[]).some(
        (h) => h.name === "Rival Realty"
      )
    ).toBe(true);
    expect(checks[1]!.clientPresent).toBe(true);
  });

  it("a placement becomes an intervention: baselines, URL verification, measuring", async () => {
    const [opp] = await sql`
      select id from citation_opportunities where project_id = ${projectId}
    `;
    const moved = await svc.updateOpportunity(user, {
      opportunityId: opp!.id as string,
      status: "won",
    });
    expect(moved.ok).toBe(true);

    const linked = await svc.linkPlacement(user, {
      opportunityId: opp!.id as string,
      urls: ["https://localnews.example/lumina-feature"],
      promptSetVersionId: versionId,
      shippedAt: new Date().toISOString().slice(0, 10),
      costUsd: 150,
    });
    expect(linked.ok).toBe(true);
    if (!linked.ok) return;

    const [after] = await sql`
      select status, intervention_id from citation_opportunities
      where id = ${opp!.id as string}
    `;
    expect(after!.status).toBe("measuring");
    expect(after!.interventionId).toBe(linked.data.interventionId);

    const [verifyJob] = await sql`
      select 1 from jobs where type = 'verify_intervention_urls'
        and payload->>'interventionId' = ${linked.data.interventionId}
    `;
    expect(verifyJob).toBeDefined();
    const baselines = await sql`
      select 1 from intervention_runs
      where intervention_id = ${linked.data.interventionId} and role = 'baseline'
    `;
    expect(baselines.length).toBeGreaterThan(0);

    const second = await svc.linkPlacement(user, {
      opportunityId: opp!.id as string,
      urls: ["https://localnews.example/again"],
      promptSetVersionId: versionId,
      shippedAt: new Date().toISOString().slice(0, 10),
    });
    expect(second.ok).toBe(false); // already measuring
  });

  it("the gap view filters by status, client presence, and ACVS floor", async () => {
    // A second opportunity to filter against, client verifiably absent.
    await sql`
      insert into citation_opportunities (project_id, domain, acvs, acvs_components)
      values (${projectId}, 'quietblog.example', 12.5,
        '{"commercialIntent": 0.1}')
    `;
    await sql`
      insert into source_presence_checks (project_id, domain, url, ok, client_present)
      values (${projectId}, 'quietblog.example', 'https://quietblog.example/', true, false)
    `;
    const all = await svc.citationGapView(projectId);
    expect(all).toHaveLength(2);

    const measuring = await svc.citationGapView(projectId, {
      statuses: ["measuring"],
    });
    expect(measuring.map((r) => r.domain)).toEqual(["localnews.example"]);

    const absent = await svc.citationGapView(projectId, { clientAbsentOnly: true });
    expect(absent.map((r) => r.domain)).toEqual(["quietblog.example"]);

    const strong = await svc.citationGapView(projectId, { minAcvs: 50 });
    expect(strong.map((r) => r.domain)).toEqual(["localnews.example"]);

    const highIntent = await svc.citationGapView(projectId, { highIntentOnly: true });
    expect(highIntent.map((r) => r.domain)).toEqual(["localnews.example"]);
  });

  it("citationMetricsForRun counts sources by owner without causal framing", async () => {
    const metrics = await svc.citationMetricsForRun(runId);
    // localnews, lumina, rival, blog.lumina (mock-provider citation excluded)
    expect(metrics.uniqueSourceDomains).toBe(4);
    // The subject is NOT is_self here — these counts prove subject resolution.
    expect(metrics.clientCitedResponses).toBe(1);
    expect(metrics.competitorCitedResponses).toBe(1);
    expect(metrics.thirdPartyDomains).toBe(2); // localnews + blog.lumina (no owner stamp)
    expect(metrics.obtainableGaps).toBe(1); // the measuring opportunity, cited by this run
  });
});
