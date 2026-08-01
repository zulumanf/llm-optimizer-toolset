/**
 * Integration tests for spec 010 — brief→draft→verify→approve→publish with a
 * fake agent caller (no network, docs/09: tests never spend tokens).
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import type { AgentCaller } from "@/lib/ai/agent";
import { seedTestActors } from "../helpers/actors";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const user: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000501",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};

describe.skipIf(!TEST_URL)("content engine (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let companySvc: typeof import("@/lib/companies/service");
  let claimsSvc: typeof import("@/lib/claims/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let content: typeof import("@/lib/content/service");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    projectSvc = await import("@/lib/projects/service");
    companySvc = await import("@/lib/companies/service");
    claimsSvc = await import("@/lib/claims/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    content = await import("@/lib/content/service");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, content_versions, content_assets, gap_findings,
       claims, tasks, evidence, intervention_runs, interventions, reports,
       brand_candidates, competitors, scores, sources, response_parses,
       mentions, companies, responses, runs, prompt_set_versions, prompts,
       prompt_sets, projects cascade`
    );
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seed(): Promise<{
    projectId: string;
    findingId: string;
    claimId: string;
    frozenVersionId: string;
  }> {
    const company = await companySvc.upsertCompany(user, {
      name: "Lumina",
      aliases: ["lumina.io"],
      domain: "lumina.io",
    });
    if (!company.ok) throw new Error(company.error.message);
    const project = await projectSvc.createProject(user, { name: "Content Test" });
    if (!project.ok) throw new Error(project.error.message);
    await claimsSvc.setSubjectCompany(user, {
      projectId: project.data.id,
      companyId: company.data.id,
    });
    const claim = await claimsSvc.proposeClaim(user, {
      projectId: project.data.id,
      key: "category_positioning",
      canonicalText: "Lumina is a link-in-bio tool built for real estate agents.",
      evidence: [{ url: "https://lumina.io", note: "homepage" }],
    });
    if (!claim.ok) throw new Error(claim.error.message);
    await claimsSvc.approveClaim(user, { claimId: claim.data.id });

    // A frozen set (needed for the publish→intervention step)
    const set = await setSvc.createPromptSet(user, {
      projectId: project.data.id,
      name: "Set",
    });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, {
      setId: set.data.id,
      text: "best tools?",
      category: "recommendation",
    });
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.data.id}
    `;

    const [run] = await sql`
      insert into runs (project_id, prompt_set_version_id, label, providers,
        trigger, budget_usd, status)
      values (${project.data.id}, ${version?.id as string}, 'seed run',
        '[]'::jsonb, 'manual', 1, 'completed')
      returning id
    `;
    const [finding] = await sql`
      insert into gap_findings (project_id, run_id, gap_type, finding,
        severity, opportunity_score, detector_version)
      values (${project.data.id}, ${run?.id}, 'entity',
        'Absent from unbranded answers', 1, 88, 'gap-detector-v1')
      returning id
    `;
    return {
      projectId: project.data.id,
      findingId: finding?.id as string,
      claimId: claim.data.id,
      frozenVersionId: version?.id as string,
    };
  }

  function fakeCaller(responses: Record<string, unknown>[]): AgentCaller {
    let call = 0;
    return async () => {
      const output = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return { text: JSON.stringify(output), tokensIn: 100, tokensOut: 200 };
    };
  }

  // verifyDraft's shipped path now runs adversarial review after the fact
  // verifier (D1) — the fake caller must answer both agents in order.
  const cleanAdversarial = { issues: [], overallRisk: "low" };

  const briefOutput = (claimId: string) => ({
    assetType: "category_page",
    title: "Link in bio for real estate agents",
    targetPrompt: "best link in bio tool for real estate agents",
    audience: "US residential real estate agents active on Instagram",
    angle: "One hub link that turns social attention into leads",
    requiredClaimIds: [claimId],
    outline: ["Why one link matters", "What Lumina does", "Getting set up"],
  });

  it("full lifecycle: brief → draft → verify → approve → publish (+intervention)", async () => {
    const { findingId, claimId, frozenVersionId } = await seed();

    const briefed = await content.createBriefFromFinding(
      user,
      { findingId },
      fakeCaller([briefOutput(claimId)])
    );
    expect(briefed.ok).toBe(true);
    if (!briefed.ok) return;

    const goodDraft = {
      markdown: `## Why one link matters\nAgents get attention on social platforms.\n\n## What Lumina does\nLumina is a link-in-bio tool built for real estate agents [claim:${claimId}].\n\n## Getting set up\nCreate a page and add your links to listings and reviews so prospects can reach everything in one place. This gives visitors a single destination for your work and contact details.`,
    };
    const drafted = await content.generateDraft(
      user,
      { assetId: briefed.data.assetId },
      fakeCaller([goodDraft])
    );
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;
    expect(drafted.data.gatePassed).toBe(true);

    // Approval before verification is blocked
    const early = await content.approveAsset(user, { assetId: briefed.data.assetId });
    expect(early.ok).toBe(false);

    const verified = await content.verifyDraft(
      user,
      { assetId: briefed.data.assetId },
      fakeCaller([
        { verdicts: [{ excerpt: "Lumina is a link-in-bio tool", verdict: "verified", reason: "matches claim" }] },
        cleanAdversarial,
      ])
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.data.passed).toBe(true);

    expect((await content.approveAsset(user, { assetId: briefed.data.assetId })).ok).toBe(true);

    const published = await content.markPublished(user, {
      assetId: briefed.data.assetId,
      publishedUrl: "https://lumina.io/for-real-estate-agents",
      promptSetVersionId: frozenVersionId,
      publishedOn: new Date().toISOString().slice(0, 10),
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    const [intervention] = await sql`
      select title, urls from interventions where id = ${published.data.interventionId}
    `;
    expect(intervention?.title).toContain("Published:");
    expect(intervention?.urls).toEqual(["https://lumina.io/for-real-estate-agents"]);
    const [asset] = await sql`
      select status from content_assets where id = ${briefed.data.assetId}
    `;
    expect(asset?.status).toBe("published");
  });

  it("the citation gate blocks drafts with uncited subject claims", async () => {
    const { findingId, claimId } = await seed();
    const briefed = await content.createBriefFromFinding(
      user,
      { findingId },
      fakeCaller([briefOutput(claimId)])
    );
    if (!briefed.ok) throw new Error(briefed.error.message);

    const badDraft = {
      markdown:
        "## Intro\nLumina is the best tool for agents and boosts leads by 300%.\n\n" +
        "## More\nEveryone loves it. It is amazing for realtors everywhere today. This section fills space to satisfy schema length requirements for the draft output contract.",
    };
    const drafted = await content.generateDraft(
      user,
      { assetId: briefed.data.assetId },
      fakeCaller([badDraft])
    );
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;
    expect(drafted.data.gatePassed).toBe(false);

    // Fact verifier says fine — the deterministic gate still blocks
    const verified = await content.verifyDraft(
      user,
      { assetId: briefed.data.assetId },
      fakeCaller([{ verdicts: [] }, cleanAdversarial])
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.data.passed).toBe(false);
    const [asset] = await sql`
      select status from content_assets where id = ${briefed.data.assetId}
    `;
    expect(asset?.status).toBe("drafted"); // stayed un-verified
  });

  it("unsupported fact-verifier verdicts block even when the gate passes", async () => {
    const { findingId, claimId } = await seed();
    const briefed = await content.createBriefFromFinding(
      user,
      { findingId },
      fakeCaller([briefOutput(claimId)])
    );
    if (!briefed.ok) throw new Error(briefed.error.message);
    await content.generateDraft(
      user,
      { assetId: briefed.data.assetId },
      fakeCaller([
        {
          markdown: `Lumina is a link-in-bio tool built for real estate agents [claim:${claimId}]. General guidance follows for agents building their online presence, with plenty of practical advice about links, bios, and profiles for social platforms and search.`,
        },
      ])
    );
    const verified = await content.verifyDraft(
      user,
      { assetId: briefed.data.assetId },
      fakeCaller([
        {
          verdicts: [
            { excerpt: "stretchy claim", verdict: "unsupported", reason: "no claim covers this" },
          ],
        },
        cleanAdversarial,
      ])
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.data.passed).toBe(false);
    expect(verified.data.unsupported).toBe(1);
  });

  it("a blocking adversarial issue keeps the asset un-verified (D1)", async () => {
    const { findingId, claimId } = await seed();
    const briefed = await content.createBriefFromFinding(
      user,
      { findingId },
      fakeCaller([briefOutput(claimId)])
    );
    if (!briefed.ok) throw new Error(briefed.error.message);
    await content.generateDraft(
      user,
      { assetId: briefed.data.assetId },
      fakeCaller([
        {
          markdown: `Lumina is a link-in-bio tool built for real estate agents [claim:${claimId}]. Additional practical guidance for agents follows, covering profiles, links, and how a single hub page keeps listings and reviews reachable from every social bio.`,
        },
      ])
    );

    // Gate passes, fact verifier passes — the adversarial reviewer is the
    // only line of defence that fires. Before D1 it never ran on this path.
    const verified = await content.verifyDraft(
      user,
      { assetId: briefed.data.assetId },
      fakeCaller([
        { verdicts: [] },
        {
          issues: [
            {
              question: "Could this harm the client if published?",
              issue: "The framing implies an exclusive endorsement no claim supports.",
              severity: "high",
              suggestedFix: "Attribute the positioning to the cited claim only.",
              quote: "built for real estate agents",
            },
          ],
          overallRisk: "high",
        },
      ])
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(verified.data.passed).toBe(false);
    expect(verified.data.adversarialBlocking).toBe(1);
    const [asset] = await sql`
      select status from content_assets where id = ${briefed.data.assetId}
    `;
    expect(asset?.status).toBe("drafted");

    // And the redraft prompt carries the adversarial finding forward — the
    // next attempt is told exactly what to fix.
    let prompt = "";
    await content.generateDraft(
      user,
      { assetId: briefed.data.assetId },
      async (args) => {
        prompt = args.user;
        return {
          text: JSON.stringify({
            markdown: `Lumina is a link-in-bio tool built for real estate agents [claim:${claimId}]. Practical setup guidance follows for agents assembling their online presence with one hub for listings, reviews, and contact links across social platforms.`,
          }),
          tokensIn: 1,
          tokensOut: 1,
        };
      }
    );
    expect(prompt).toContain("PREVIOUS draft failed verification");
    expect(prompt).toContain("exclusive endorsement");
  });

  it("briefing requires approved claims; versions are immutable", async () => {
    const { findingId, claimId } = await seed();
    await sql`update claims set status = 'superseded' where status = 'approved'`;
    const blocked = await content.createBriefFromFinding(
      user,
      { findingId },
      fakeCaller([briefOutput(claimId)])
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.message).toMatch(/approved claims/);

    await sql`update claims set status = 'approved' where status = 'superseded'`;
    const briefed = await content.createBriefFromFinding(
      user,
      { findingId },
      fakeCaller([briefOutput(claimId)])
    );
    if (!briefed.ok) throw new Error(briefed.error.message);
    await content.generateDraft(
      user,
      { assetId: briefed.data.assetId },
      fakeCaller([
        { markdown: `Lumina is a link-in-bio tool built for real estate agents [claim:${claimId}]. Plus enough additional general material about agent marketing to satisfy the minimum draft length requirement for this schema contract easily.` },
      ])
    );
    await expect(
      sql`update content_versions set body = 'tampered'`
    ).rejects.toThrow(/insert-only/);
  });

  it("wording a human prohibited on a claim fails the gate deterministically (D4)", async () => {
    const { findingId, claimId } = await seed();
    const claims = await import("@/lib/claims/service");
    const worded = await claims.setClaimWording(user, {
      claimId,
      prohibitedWording: ["#1 link-in-bio tool"],
    });
    expect(worded.ok).toBe(true);

    const briefed = await content.createBriefFromFinding(
      user,
      { findingId },
      fakeCaller([briefOutput(claimId)])
    );
    if (!briefed.ok) throw new Error(briefed.error.message);

    // The model ignores the "never say" instruction — the gate must not.
    const drafted = await content.generateDraft(
      user,
      { assetId: briefed.data.assetId },
      fakeCaller([
        {
          markdown: `Lumina is the #1 link-in-bio tool for real estate agents [claim:${claimId}]. General setup guidance follows for agents building a single hub for their listings, reviews, and contact links across social platforms.`,
        },
      ])
    );
    expect(drafted.ok).toBe(true);
    if (!drafted.ok) return;
    expect(drafted.data.gatePassed).toBe(false);

    const [version] = await sql`
      select verification from content_versions
      where asset_id = ${briefed.data.assetId} order by version desc limit 1
    `;
    const gate = (version!.verification as { gate: { prohibitedWordingHits: { phrase: string }[] } }).gate;
    expect(gate.prohibitedWordingHits[0]!.phrase).toBe("#1 link-in-bio tool");
  });
});
