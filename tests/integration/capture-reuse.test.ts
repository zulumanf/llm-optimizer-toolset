/**
 * Spec 054: shared market captures. The market's answer is a fact about
 * the market — a second project asking the byte-identical question inside
 * the window copies the capture (cost 0, provenance in reused_from)
 * instead of paying the provider again. Same-project runs always sample
 * fresh, and copies never serve as sources.
 *
 * The registry is stubbed so 'openai' is a counting fake — reuse must be
 * proven by the absence of provider calls, and mock is excluded from
 * reuse by design.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";
import { unwrap } from "../helpers/result";

const providerCalls: { promptText: string; model: string }[] = [];

vi.mock("@/lib/ai/registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/ai/registry")>();
  const fakeOpenai = {
    id: "openai" as const,
    models: [
      { id: "gpt-5.4-2026-03-05", label: "GPT-5.4", provider: "openai" as const },
    ],
    async runPrompt(req: { model: string; promptText: string }) {
      providerCalls.push({ promptText: req.promptText, model: req.model });
      return {
        rawPayload: { fake: true, prompt: req.promptText, n: providerCalls.length },
        responseText: `For that market I'd recommend Rivera Team. (call ${providerCalls.length})`,
        refusal: false,
        tokensIn: 20,
        tokensOut: 30,
        requestParams: { sampling: "provider_default" as const },
      };
    },
  };
  return {
    ...real,
    getProvider: (id: string) =>
      id === "openai" ? fakeOpenai : real.getProvider(id as never),
  };
});

const TEST_URL = process.env.TEST_DATABASE_URL;
const MARKET_PROMPT = "Who are the best real estate teams in Jersey City?";

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-0000000000ef",
  email: "op@test.local",
  name: "Op",
  role: "operator",
};

describe.skipIf(!TEST_URL)("shared market captures (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let claims: typeof import("@/lib/claims/service");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    companySvc = await import("@/lib/companies/service");
    claims = await import("@/lib/claims/service");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, scores, sources, response_parses, mentions,
       response_citations, brand_candidates, companies, responses, runs,
       prompt_set_versions, prompts, prompt_sets, projects cascade`
    );
    providerCalls.length = 0;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function drainJobs(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) return;
      if (job.type === "execute_run") await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await scoring.computeScores(job.payload.runId as string);
      await jobs.completeJob(job.id);
    }
  }

  async function seedProjectRun(
    name: string,
    subjectName: string,
    promptText = MARKET_PROMPT,
    // Spec 161: reuse is a prospect-benchmark feature; client projects never copy.
    kind: "prospect" | "client" = "prospect",
    runOptions: { reuseCaptures?: boolean } = {}
  ): Promise<{ projectId: string; runId: string; versionId: string }> {
    const subject = unwrap(await companySvc.upsertCompany(operator, { name: subjectName }));
    const project = unwrap(await projectSvc.createProject(operator, { name }));
    await sql`update projects set kind = ${kind} where id = ${project.id}`;
    unwrap(
      await claims.setSubjectCompany(operator, {
        projectId: project.id,
        companyId: subject.id,
      })
    );
    const set = unwrap(
      await setSvc.createPromptSet(operator, { projectId: project.id, name: "Set" })
    );
    unwrap(
      await promptSvc.addPrompt(operator, {
        setId: set.id,
        text: promptText,
        category: "recommendation",
      })
    );
    unwrap(await setSvc.freezePromptSet(operator, { id: set.id }));
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.id}
    `;
    const run = unwrap(
      await runSvc.startRun(operator, {
        projectId: project.id,
        promptSetVersionId: version?.id as string,
        providers: [
          { provider: "openai", model: "gpt-5.4-2026-03-05", repetitions: 2 },
        ],
        budgetUsd: 5,
        label: "market run",
        ...runOptions,
      })
    );
    await drainJobs();
    return { projectId: project.id, runId: run.id, versionId: version?.id as string };
  }

  it("a second project reuses instead of paying; parse and score still work", async () => {
    const a = await seedProjectRun("Client A", "Rivera Team");
    expect(providerCalls).toHaveLength(2);

    const b = await seedProjectRun("Client B", "Meridian Group");
    // Zero additional provider calls — both cells were satisfied by copies.
    expect(providerCalls).toHaveLength(2);

    const copies = await sql`
      select reused_from, cost_usd, response_text, tokens_in from responses
      where run_id = ${b.runId} order by repetition
    `;
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy.reusedFrom).not.toBeNull();
      expect(Number(copy.costUsd)).toBe(0);
      expect(copy.responseText).toContain("Rivera Team");
      expect(Number(copy.tokensIn)).toBe(20);
    }
    // Provenance points at Client A's original captures.
    const [origin] = await sql`
      select run_id from responses where id = ${copies[0]!.reusedFrom}
    `;
    expect(origin?.runId).toBe(a.runId);

    // Classification ran against B's OWN company set and scoring produced
    // rows for B's subject — one capture, N company sets (the audit's rule).
    const [score] = await sql`
      select s.value from scores s
      join companies c on c.id = s.company_id
      where s.run_id = ${b.runId} and s.metric = 'mention_rate'
        and s.provider = 'all' and c.name = 'Meridian Group'
    `;
    expect(score).toBeDefined();
  });

  it("same-project repeat runs never reuse — retests sample fresh", async () => {
    const a = await seedProjectRun("Client A", "Rivera Team");
    expect(providerCalls).toHaveLength(2);
    const again = unwrap(
      await runSvc.startRun(operator, {
        projectId: a.projectId,
        promptSetVersionId: a.versionId,
        providers: [
          { provider: "openai", model: "gpt-5.4-2026-03-05", repetitions: 2 },
        ],
        budgetUsd: 5,
        label: "retest",
      })
    );
    await drainJobs();
    expect(providerCalls).toHaveLength(4);
    const [copied] = await sql`
      select count(*)::int as n from responses
      where run_id = ${again.id} and reused_from is not null
    `;
    expect(copied?.n).toBe(0);
  });

  it("a third project points provenance at the ORIGINAL, never at a copy", async () => {
    const a = await seedProjectRun("Client A", "Rivera Team");
    await seedProjectRun("Client B", "Meridian Group");
    const c = await seedProjectRun("Client C", "Crestview Properties");
    expect(providerCalls).toHaveLength(2);
    const originals = await sql`
      select id from responses where run_id = ${a.runId}
    `;
    const originalIds = new Set(originals.map((r) => r.id as string));
    const copies = await sql`
      select reused_from from responses where run_id = ${c.runId}
    `;
    for (const copy of copies) {
      expect(originalIds.has(copy.reusedFrom as string)).toBe(true);
    }
  });

  it("sources older than the window are ignored", async () => {
    const a = await seedProjectRun("Client A", "Rivera Team");
    // Age Client A's captures past the 72h window. Responses are insert-only
    // to the APP; the harness simulating time is what the trigger permits
    // nothing to do — so seed the aged state via a fresh table truncate and
    // raw insert instead.
    const aged = await sql`
      select id, run_id, prompt_id, prompt_text, provider, model, repetition,
        raw_payload, response_text, refusal
      from responses where run_id = ${a.runId}
    `;
    await sql.unsafe("truncate mentions, response_parses, scores, response_citations cascade");
    await sql.unsafe("alter table responses disable trigger responses_immutable");
    await sql`delete from responses where run_id = ${a.runId}`;
    for (const row of aged) {
      await sql`
        insert into responses (run_id, prompt_id, prompt_text, provider, model,
          repetition, raw_payload, response_text, refusal, requested_at)
        values (${row.runId}, ${row.promptId}, ${row.promptText}, ${row.provider},
          ${row.model}, ${row.repetition}, ${sql.json(row.rawPayload as never)},
          ${row.responseText}, ${row.refusal}, now() - interval '5 days')
      `;
    }
    await sql.unsafe("alter table responses enable trigger responses_immutable");

    providerCalls.length = 0;
    await seedProjectRun("Client B", "Meridian Group");
    // Stale source → live calls, no copies.
    expect(providerCalls).toHaveLength(2);
  });

  it("reuse_captures=false forces live calls even when a source exists", async () => {
    await seedProjectRun("Client A", "Rivera Team");
    expect(providerCalls).toHaveLength(2);

    const subject = unwrap(await companySvc.upsertCompany(operator, { name: "Opt Out Co" }));
    const project = unwrap(await projectSvc.createProject(operator, { name: "Client Opt-Out" }));
    unwrap(
      await claims.setSubjectCompany(operator, {
        projectId: project.id,
        companyId: subject.id,
      })
    );
    const set = unwrap(
      await setSvc.createPromptSet(operator, { projectId: project.id, name: "Set" })
    );
    unwrap(
      await promptSvc.addPrompt(operator, {
        setId: set.id,
        text: MARKET_PROMPT,
        category: "recommendation",
      })
    );
    unwrap(await setSvc.freezePromptSet(operator, { id: set.id }));
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.id}
    `;
    const run = unwrap(
      await runSvc.startRun(operator, {
        projectId: project.id,
        promptSetVersionId: version?.id as string,
        providers: [
          { provider: "openai", model: "gpt-5.4-2026-03-05", repetitions: 2 },
        ],
        budgetUsd: 5,
        label: "fresh sampling",
      })
    );
    await sql`update runs set reuse_captures = false where id = ${run.id}`;
    await drainJobs();
    expect(providerCalls).toHaveLength(4);
  });
  // ---------------------------------------------------------- spec 161
  it("spec 161 B1: a client project never copies — fresh capture even with an eligible source", async () => {
    await seedProjectRun("Prospect A", "Rivera Team");
    expect(providerCalls).toHaveLength(2);
    const c = await seedProjectRun("Client Medina (synthetic)", "Medina Synthetic", MARKET_PROMPT, "client");
    expect(providerCalls).toHaveLength(4); // both cells asked of the provider
    const [run] = await sql`select reuse_captures from runs where id = ${c.runId}`;
    expect(run?.reuseCaptures).toBe(false);
    const [copied] = await sql`select count(*)::int as n from responses where run_id = ${c.runId} and reused_from is not null`;
    expect(copied?.n).toBe(0);
  });

  it("spec 161 B1: a client project refuses an explicit reuse request; a prospect may opt out", async () => {
    const svc = await import("@/lib/runs/service");
    expect(svc.captureReuseFor("client", undefined)).toBe(false);
    expect(svc.captureReuseFor("client", false)).toBe(false);
    expect(() => svc.captureReuseFor("client", true)).toThrow(/always captured fresh/);
    expect(svc.captureReuseFor("prospect", undefined)).toBe(true);
    expect(svc.captureReuseFor("prospect", false)).toBe(false);
    await expect(seedProjectRun("Client X", "X Co", MARKET_PROMPT, "client", { reuseCaptures: true })).rejects.toThrow(/always captured fresh/);
    const p = await seedProjectRun("Prospect Opt-out", "Opt Co", MARKET_PROMPT, "prospect", { reuseCaptures: false });
    const [run] = await sql`select reuse_captures from runs where id = ${p.runId}`;
    expect(run?.reuseCaptures).toBe(false);
  });

  it("spec 161 B1: a historical client run flagged for reuse is guarded at execution", async () => {
    await seedProjectRun("Prospect A", "Rivera Team");
    const c = await seedProjectRun("Client Old", "Old Co", MARKET_PROMPT, "client");
    // Re-run the same version with the flag forced on, as pre-161 runs had it.
    const again = unwrap(await runSvc.startRun(operator, { projectId: c.projectId, promptSetVersionId: c.versionId, providers: [{ provider: "openai", model: "gpt-5.4-2026-03-05", repetitions: 2 }], budgetUsd: 5, label: "historical flag" }));
    await sql`update runs set reuse_captures = true where id = ${again.id}`;
    const before = providerCalls.length;
    await drainJobs();
    expect(providerCalls.length).toBe(before + 2);
    const [copied] = await sql`select count(*)::int as n from responses where run_id = ${again.id} and reused_from is not null`;
    expect(copied?.n).toBe(0);
  });

  it("spec 161 B2: a copy carries the time the provider was asked; historical copies read it through their source", async () => {
    const a = await seedProjectRun("Prospect A", "Rivera Team");
    const b = await seedProjectRun("Prospect B", "Meridian Group");
    const pairs = await sql`
      select c.requested_at as copy_at, o.requested_at as origin_at
      from responses c join responses o on o.id = c.reused_from where c.run_id = ${b.runId}
    `;
    expect(pairs.length).toBe(2);
    for (const p of pairs) expect((p.copyAt as Date).getTime()).toBe((p.originAt as Date).getTime());

    // A pre-161 copy stamped with copy time: the read helper returns the source's time.
    const [origin] = await sql`select id, prompt_id, prompt_text, requested_at from responses where run_id = ${a.runId} limit 1`;
    const [legacyRun] = await sql`insert into runs (project_id, prompt_set_version_id, label, providers, budget_usd, status, trigger) values (${b.projectId}, ${b.versionId}, 'legacy copy', '[]'::jsonb, 1, 'completed', 'manual') returning id`;
    const [legacy] = await sql`
      insert into responses (run_id, prompt_id, prompt_text, provider, model, repetition, response_text, reused_from, requested_at)
      values (${legacyRun!.id}, ${origin!.promptId}, ${origin!.promptText}, 'openai', 'gpt-5.4-2026-03-05', 9, 'copy', ${origin!.id}, now() + interval '2 days')
      returning id
    `;
    const { captureTimeSql } = await import("@/lib/runs/reuse");
    const [t] = await sql`select ${captureTimeSql("x")} as at from responses x where x.id = ${legacy!.id}`;
    expect((t!.at as Date).getTime()).toBe((origin!.requestedAt as Date).getTime());

    // The answer page's read returns the source.
    const { getResponse } = await import("@/db/runs");
    const detail = (await getResponse(legacy!.id as string))!;
    expect(detail.source).toMatchObject({ runId: a.runId, projectId: a.projectId, projectName: "Prospect A" });
    expect(detail.source!.requestedAt.getTime()).toBe((origin!.requestedAt as Date).getTime());
    expect((await getResponse(origin!.id as string))!.source).toBeNull();
  });

  it("spec 161 B4: a snapshot over copied answers counts them and reports the true capture time", async () => {
    const a = await seedProjectRun("Prospect A", "Rivera Team");
    const b = await seedProjectRun("Prospect B", "Meridian Group");
    const { buildMeasurementSnapshot } = await import("@/lib/engagements/measurement");
    const [subject] = await sql`select subject_company_id from projects where id = ${b.projectId}`;
    const snapB = await buildMeasurementSnapshot({ runId: b.runId, provider: "openai", subjectCompanyId: subject!.subjectCompanyId as string, competitorCompanyIds: [] });
    expect(snapB.reusedCount).toBe(2);
    const [latest] = await sql`select max(requested_at) as at from responses where run_id = ${a.runId}`;
    expect(snapB.capturedAt).toBe((latest!.at as Date).toISOString());
    const [subjectA] = await sql`select subject_company_id from projects where id = ${a.projectId}`;
    const snapA = await buildMeasurementSnapshot({ runId: a.runId, provider: "openai", subjectCompanyId: subjectA!.subjectCompanyId as string, competitorCompanyIds: [] });
    expect(snapA.reusedCount).toBe(0);
  });
});
