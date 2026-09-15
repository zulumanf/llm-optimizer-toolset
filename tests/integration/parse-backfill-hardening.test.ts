/**
 * Evidence pipeline hardening (2026-09-14) — integration:
 *  - provider blocked ⇒ existing classifier judgment preserved, work deferred
 *  - ledger reconstruction from immutable revisions instead of re-classifying
 *  - CURRENT_REVISION is class-first (heuristic never demotes LLM)
 *  - batch attach ⇒ one company-scoped job per company, deduplicated, no
 *    per-answer parse jobs, semantic ledger untouched
 *  - backfill under a blocked provider writes nothing heuristic and resumes
 *  - alias-only change re-resolves without re-judging judged pairs
 *  - the whole flow emits no customer communication
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

const llm = vi.hoisted(() => ({ mode: "ok" as "ok" | "throw", calls: 0 }));

vi.mock("@/lib/parsing/classify-llm", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/parsing/classify-llm")>();
  const { scanAliases } = await import("@/lib/parsing/prepass");
  return {
    ...mod,
    classifyResponseLlm: async (args: { responseText: string; companies: { id: string; name: string; aliases: string[]; domain: string | null }[] }) => {
      llm.calls += 1;
      if (llm.mode === "throw") {
        const err = new Error("insufficient_quota: credit balance exhausted") as Error & { status?: number };
        err.status = 429;
        throw err;
      }
      const hits = new Set(scanAliases(args.responseText, args.companies).map((h) => h.companyId));
      return args.companies.filter((c) => hits.has(c.id)).map((c) => ({
        companyId: c.id, mentioned: true, recommended: true, listPosition: null, sentiment: "positive" as const,
        excerpt: null, citedUrls: [] as string[], confidence: 0.95, needsReview: false,
      }));
    },
  };
});

const user: CurrentUser = { id: "00000000-0000-4000-8000-0000000000ff", email: "op@test.local", name: "Operator", role: "operator" };

describe.skipIf(!TEST_URL)("parse/backfill hardening (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let competitorSvc: typeof import("@/lib/competitors/service");
  let parsing: typeof import("@/lib/parsing/service");
  let backfill: typeof import("@/lib/parsing/backfill");
  let scoring: typeof import("@/lib/scoring/compute");
  let mentionsDb: typeof import("@/db/mentions");
  let mock: typeof import("@/lib/ai/mock");
  let constants: typeof import("@/lib/constants");

  beforeAll(async () => {
    process.env.OPENAI_API_KEY = "test-key-classifier-required";
    ({ sql } = await import("@/db/client"));
    await truncateAll(sql);
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    companySvc = await import("@/lib/companies/service");
    competitorSvc = await import("@/lib/competitors/service");
    parsing = await import("@/lib/parsing/service");
    backfill = await import("@/lib/parsing/backfill");
    scoring = await import("@/lib/scoring/compute");
    mentionsDb = await import("@/db/mentions");
    mock = await import("@/lib/ai/mock");
    constants = await import("@/lib/constants");
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, brand_candidates, competitors, scores, sources,
       response_parses, run_company_parses, company_backfills, mentions, companies, responses, runs,
       prompt_set_versions, prompts, prompt_sets, projects, prospect_benchmarks, prospects, market_launches, markets cascade`
    );
    mock.resetMockProvider();
    llm.mode = "ok";
    llm.calls = 0;
  });

  afterAll(async () => {
    delete process.env.OPENAI_API_KEY;
    await sql.end();
  });

  /** Drain the queue; a failing job is failed the way the worker fails it. */
  async function drainJobs(): Promise<string[]> {
    const errors: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) return errors;
      try {
        if (job.type === "execute_run") await execute.executeRun(job.payload.runId as string);
        else if (job.type === "parse_response") await parsing.parseResponse(job.payload.responseId as string, { reparse: job.payload.reparse === true });
        else if (job.type === "compute_scores") await scoring.computeScores(job.payload.runId as string);
        else if (job.type === "backfill_company") await backfill.runCompanyBackfill(job.payload as unknown as import("@/lib/parsing/backfill").BackfillPayload);
        await jobs.completeJob(job.id);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : "unknown");
        await sql`update jobs set status = 'failed', last_error = ${errors.at(-1) ?? null} where id = ${job.id}`;
      }
    }
    return errors;
  }

  async function seedProjectWithRun(): Promise<{ projectId: string; runId: string; luminaId: string }> {
    const lumina = await companySvc.upsertCompany(user, { name: "Lumina", isSelf: true });
    if (!lumina.ok) throw new Error(lumina.error.message);
    const project = await projectSvc.createProject(user, { name: "Hardening Test" });
    if (!project.ok) throw new Error(project.error.message);
    const set = await setSvc.createPromptSet(user, { projectId: project.data.id, name: "Set" });
    if (!set.ok) throw new Error(set.error.message);
    await promptSvc.addPrompt(user, { setId: set.data.id, text: "What are the best tools?", category: "recommendation" });
    await setSvc.freezePromptSet(user, { id: set.data.id });
    const [version] = await sql`select id from prompt_set_versions where prompt_set_id = ${set.data.id}`;
    const started = await runSvc.startRun(user, {
      projectId: project.data.id, promptSetVersionId: version?.id as string,
      providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }], budgetUsd: 5, label: "hardening run",
    });
    if (!started.ok) throw new Error(started.error.message);
    const errors = await drainJobs();
    expect(errors).toEqual([]);
    const [run] = await sql`select id from runs where project_id = ${project.data.id} order by started_at desc limit 1`;
    return { projectId: project.data.id, runId: run?.id as string, luminaId: lumina.data.id };
  }

  const countRows = async (table: string, where = "true"): Promise<number> => {
    const [row] = await sql.unsafe(`select count(*)::int as n from ${table} where ${where}`);
    return Number((row as unknown as { n: number }).n);
  };

  it("classifier parses stamp LLM provenance in both the ledger and the revisions", async () => {
    const { runId } = await seedProjectWithRun();
    const ledger = await sql`select parser_version, classifier_model, classifier_prompt_version, reconstructed_from_mentions from response_parses where run_id = ${runId}`;
    expect(ledger).toHaveLength(2);
    for (const row of ledger) {
      expect(row.parserVersion).toBe(constants.PARSER_VERSION_LLM);
      expect(row.classifierModel).toBeTruthy();
      expect(row.classifierPromptVersion).toBeTruthy();
      expect(row.reconstructedFromMentions).toBe(false);
    }
    expect(llm.calls).toBe(2);
  });

  it("ledger reconstruction: a deleted ledger is restored from the immutable revisions, never re-classified", async () => {
    const { runId } = await seedProjectWithRun();
    const [resp] = await sql`select id from responses where run_id = ${runId} limit 1`;
    const before = await countRows("mentions", `response_id = '${resp?.id as string}'`);
    await sql`delete from response_parses where response_id = ${resp?.id}`; // the legacy backfill's damage
    llm.mode = "throw";
    const callsBefore = llm.calls;
    await parsing.parseResponse(resp?.id as string);
    expect(llm.calls).toBe(callsBefore);
    expect(await countRows("mentions", `response_id = '${resp?.id as string}'`)).toBe(before);
    const [ledger] = await sql`select parser_version, reconstructed_from_mentions, classifier_model from response_parses where response_id = ${resp?.id}`;
    expect(ledger?.parserVersion).toBe(constants.PARSER_VERSION_LLM);
    expect(ledger?.reconstructedFromMentions).toBe(true);
    expect(ledger?.classifierModel).toBeTruthy();
  });

  it("provider blocked: a response holding a classifier-class judgment is preserved and the parse is deferred", async () => {
    // Seed under heuristic policy (no key) so the active-version (v2) ledger
    // and revisions are absent; then a human-reviewed revision makes the pair
    // classifier-class. With a key configured and the provider down, the
    // guard — not reconstruction — must protect it.
    delete process.env.OPENAI_API_KEY;
    const { runId, luminaId } = await seedProjectWithRun();
    process.env.OPENAI_API_KEY = "test-key-classifier-required";
    const [resp] = await sql`select id from responses where run_id = ${runId} limit 1`;
    await sql`
      insert into mentions (response_id, company_id, revision, mentioned, recommended, parser_version, confidence, needs_review, reviewed_by)
      values (${resp?.id}, ${luminaId}, 2, true, true, ${constants.PARSER_VERSION_ADJUDICATION}, 0.9, false, ${user.id})
    `;
    const before = await countRows("mentions", `response_id = '${resp?.id as string}'`);
    llm.mode = "throw";
    await expect(parsing.parseResponse(resp?.id as string)).rejects.toThrow(/Classifier unavailable \(CAPACITY_BLOCKED\)/);
    expect(await countRows("mentions", `response_id = '${resp?.id as string}'`)).toBe(before);
    expect(await countRows("response_parses", `response_id = '${resp?.id as string}' and parser_version = '${constants.PARSER_VERSION_LLM}'`)).toBe(0);
    // A fresh response with NO classifier history keeps the documented
    // graceful degradation: truthfully stamped heuristic, upgradeable later.
    const [other] = await sql`select id from responses where run_id = ${runId} and id <> ${resp?.id} limit 1`;
    await parsing.parseResponse(other?.id as string);
    expect(await countRows("response_parses", `response_id = '${other?.id as string}' and parser_version = '${constants.PARSER_VERSION_HEURISTIC}'`)).toBe(1);
  });

  it("CURRENT_REVISION is class-first: a newer heuristic row does not demote the LLM judgment", async () => {
    const { runId, luminaId } = await seedProjectWithRun();
    const [resp] = await sql`select id from responses where run_id = ${runId} limit 1`;
    await sql`
      insert into mentions (response_id, company_id, revision, mentioned, recommended, parser_version, confidence, needs_review)
      values (${resp?.id}, ${luminaId}, 2, true, false, ${constants.PARSER_VERSION_HEURISTIC}, 0.85, false)
    `;
    const current = await mentionsDb.currentMentionsForRun(runId);
    const pair = current.find((m) => m.responseId === (resp?.id as string) && m.companyId === luminaId);
    expect(pair?.revision).toBe(1);
    expect(pair?.parserVersion).toBe(constants.PARSER_VERSION_LLM);
    expect(pair?.recommended).toBe(true);
    // ...while a newer LLM revision does supersede, heuristic rows in between notwithstanding.
    const [other] = await sql`select id from responses where run_id = ${runId} and id <> ${resp?.id} limit 1`;
    await sql`
      insert into mentions (response_id, company_id, revision, mentioned, recommended, parser_version, confidence, needs_review)
      values (${other?.id}, ${luminaId}, 2, true, false, ${constants.PARSER_VERSION_HEURISTIC}, 0.85, false),
             (${other?.id}, ${luminaId}, 3, true, false, ${constants.PARSER_VERSION_LLM}, 0.95, false)
    `;
    const again = await mentionsDb.currentMentionsForRun(runId);
    const upgraded = again.find((m) => m.responseId === (other?.id as string) && m.companyId === luminaId);
    expect(upgraded?.revision).toBe(3);
    expect(upgraded?.recommended).toBe(false);
  });

  it("batch attach: two companies ⇒ two deduplicated company jobs, zero parse_response jobs, ledger untouched, judgments reused", async () => {
    const { projectId, runId } = await seedProjectWithRun();
    const acme = await companySvc.upsertCompany(user, { name: "Acme" });
    const beta = await companySvc.upsertCompany(user, { name: "Beta Brokerage" });
    if (!acme.ok || !beta.ok) throw new Error("company");
    const ledgerBefore = await countRows("response_parses");
    const callsBefore = llm.calls;
    for (const c of [acme, beta]) {
      const added = await competitorSvc.addCompetitor(user, { projectId, companyId: c.data.id, tier: "secondary", backfill: false });
      expect(added.ok).toBe(true);
    }
    const first = await backfill.enqueueCompanyBackfill(projectId, acme.data.id, "competitor_attach");
    const dup = await backfill.enqueueCompanyBackfill(projectId, acme.data.id, "competitor_attach");
    await backfill.enqueueCompanyBackfill(projectId, beta.data.id, "competitor_attach");
    expect(dup.deduplicated).toBe(true);
    expect(dup.jobId).toBe(first.jobId);
    expect(first.estimate).toEqual({ runs: 1, responses: 2 });
    expect(await countRows("jobs", "type = 'backfill_company' and status = 'queued'")).toBe(2);
    expect(await countRows("jobs", "type = 'parse_response' and status = 'queued'")).toBe(0);

    expect(await drainJobs()).toEqual([]);
    expect(await countRows("response_parses")).toBe(ledgerBefore);
    expect(llm.calls - callsBefore).toBe(2); // Acme is named in both answers; Beta in none
    expect(await countRows("mentions", `company_id = '${acme.data.id}' and mentioned`)).toBe(2);
    expect(await countRows("mentions", `company_id = '${beta.data.id}'`)).toBe(0);
    const ledgers = await sql`select company_id, hits, inserted from run_company_parses where run_id = ${runId} order by hits desc`;
    expect(ledgers.map((l) => [l.companyId, l.hits, l.inserted])).toEqual([[acme.data.id, 2, 2], [beta.data.id, 0, 0]]);
    const fills = await sql`select status, classifier_calls, parses_reused, mentions_inserted from company_backfills order by classifier_calls desc`;
    expect(fills.map((f) => [f.status, f.classifierCalls, f.mentionsInserted])).toEqual([["completed", 2, 2], ["completed", 0, 0]]);

    // Re-running the same backfill is a no-op: ledger reuse, zero classifier calls.
    const again = await backfill.enqueueCompanyBackfill(projectId, acme.data.id, "operator");
    expect(again.deduplicated).toBe(false);
    expect(await drainJobs()).toEqual([]);
    const [rerun] = await sql`select classifier_calls, parses_reused from company_backfills where id = ${again.backfillId}`;
    expect(rerun?.classifierCalls).toBe(0);
    expect(rerun?.parsesReused).toBe(1);
    expect(await countRows("mentions", `company_id = '${acme.data.id}'`)).toBe(2);
  });

  it("backfill under a blocked provider writes nothing heuristic, records provider_blocked, and resumes idempotently", async () => {
    const { projectId } = await seedProjectWithRun();
    const acme = await companySvc.upsertCompany(user, { name: "Acme" });
    if (!acme.ok) throw new Error("company");
    llm.mode = "throw";
    const added = await competitorSvc.addCompetitor(user, { projectId, companyId: acme.data.id, tier: "secondary" });
    expect(added.ok).toBe(true);
    const errors = await drainJobs();
    expect(errors.some((e) => /Classifier unavailable/.test(e))).toBe(true);
    expect(await countRows("mentions", `company_id = '${acme.data.id}'`)).toBe(0);
    expect(await countRows("run_company_parses")).toBe(0);
    const [blocked] = await sql`select status, provider_state from company_backfills`;
    expect(blocked?.status).toBe("provider_blocked");
    expect(blocked?.providerState).toBe("CAPACITY_BLOCKED");

    llm.mode = "ok";
    await backfill.enqueueCompanyBackfill(projectId, acme.data.id, "repair");
    expect(await drainJobs()).toEqual([]);
    expect(await countRows("mentions", `company_id = '${acme.data.id}' and parser_version = '${constants.PARSER_VERSION_LLM}'`)).toBe(2);
    expect(await countRows("mentions", `company_id = '${acme.data.id}' and parser_version = '${constants.PARSER_VERSION_HEURISTIC}'`)).toBe(0);
  });

  it("alias-only change re-resolves the company without re-judging already-judged answers", async () => {
    const { projectId, runId } = await seedProjectWithRun();
    const acme = await companySvc.upsertCompany(user, { name: "Acme" });
    if (!acme.ok) throw new Error("company");
    const added = await competitorSvc.addCompetitor(user, { projectId, companyId: acme.data.id, tier: "secondary" });
    expect(added.ok).toBe(true);
    expect(await drainJobs()).toEqual([]);
    const callsAfterAttach = llm.calls;

    const renamed = await companySvc.upsertCompany(user, { id: acme.data.id, name: "Acme", aliases: ["Acme Corp"] });
    expect(renamed.ok).toBe(true);
    expect(await backfill.enqueueAliasBackfills(acme.data.id)).toBe(1);
    expect(await drainJobs()).toEqual([]);
    expect(llm.calls).toBe(callsAfterAttach); // both hits already judged → reused
    expect(await countRows("run_company_parses", `run_id = '${runId}' and company_id = '${acme.data.id}'`)).toBe(2); // two alias-graph hashes
    expect(await countRows("mentions", `company_id = '${acme.data.id}'`)).toBe(2);
    const [fill] = await sql`select classifier_calls, parses_reused, trigger from company_backfills where trigger = 'alias_change'`;
    expect(fill?.classifierCalls).toBe(0);
    expect(fill?.parsesReused).toBe(2);
  });

  it("a market-level project's run cannot be bound as a benchmark for a prospect from another market (BENCHMARK_MARKET_MISMATCH)", async () => {
    const { projectId, runId, luminaId } = await seedProjectWithRun();
    const prospects = await import("@/lib/prospects/service");
    const DE = "cccccccc-0000-4000-8000-000000000001";
    const NC = "cccccccc-0000-4000-8000-000000000002";
    const LAUNCH_NC = "cccccccc-0000-4000-8000-000000000012";
    const LAUNCH_DE = "cccccccc-0000-4000-8000-000000000011";
    await sql`insert into markets (id, name, kind, state_code) values (${DE}, 'Wilmington', 'city', 'DE'), (${NC}, 'Wilmington NC', 'city', 'NC') on conflict do nothing`;
    await sql`insert into market_launches (id, name, market_id, status) values (${LAUNCH_DE}, 'DE', ${DE}, 'researching'), (${LAUNCH_NC}, 'NC', ${NC}, 'researching') on conflict do nothing`;
    await sql`update projects set market_id = ${DE} where id = ${projectId}`;
    const nc = await prospects.createProspect(user, { launchId: LAUNCH_NC, companyId: luminaId, businessName: "Lumina NC", prospectType: "team", source: "manual" });
    const de = await prospects.createProspect(user, { launchId: LAUNCH_DE, companyId: luminaId, businessName: "Lumina DE", prospectType: "team", source: "manual" });
    if (!nc.ok || !de.ok) throw new Error("prospect fixture");
    const cross = await prospects.linkBenchmark(user, { prospectId: nc.data.prospectId, runId });
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.error.message).toMatch(/BENCHMARK_MARKET_MISMATCH/);
    const same = await prospects.linkBenchmark(user, { prospectId: de.data.prospectId, runId });
    expect(same.ok).toBe(true);
    expect(await countRows("prospect_benchmarks", `run_id = '${runId}'`)).toBe(1);
  });

  it("enqueueParseJobs is idempotent against the queue: a second enqueue for the same run adds no duplicate parse jobs", async () => {
    const { runId } = await seedProjectWithRun();
    await sql`delete from response_parses where run_id = ${runId}`; // simulate an explicit refresh that needs re-parsing
    const first = await parsing.enqueueParseJobs(runId, { reparse: true });
    const second = await parsing.enqueueParseJobs(runId, { reparse: true });
    expect(first).toBe(2);
    expect(second).toBe(0);
    const [dupes] = await sql`
      select count(*)::int as n from (
        select payload->>'responseId' as rid, count(*) as c from jobs
        where type = 'parse_response' and status = 'queued' group by 1 having count(*) > 1
      ) d`;
    expect(dupes?.n).toBe(0);
  });

  it("emits no customer communication", async () => {
    const { projectId } = await seedProjectWithRun();
    const acme = await companySvc.upsertCompany(user, { name: "Acme" });
    if (!acme.ok) throw new Error("company");
    await competitorSvc.addCompetitor(user, { projectId, companyId: acme.data.id, tier: "secondary" });
    expect(await drainJobs()).toEqual([]);
    expect(await countRows("outreach_drafts")).toBe(0);
    expect(await countRows("prospect_outreach_sends")).toBe(0);
    expect(await countRows("outreach_messages")).toBe(0);
    const types = await sql`select distinct type from jobs`;
    expect(types.map((t) => t.type as string).filter((t) => /send|outreach|email|handoff|video|followup/i.test(t))).toEqual([]);
  });
});
