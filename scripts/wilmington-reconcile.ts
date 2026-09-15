/**
 * Legacy Wilmington reconciliation (2026-09-14). Deterministic and read-only
 * unless --apply is passed; nothing is deleted.
 *
 * Provenance rule: a run's geography is what its IMMUTABLE frozen prompts
 * ask about, corroborated by the installed pack's hierarchy — never the
 * project label, the run label, or the CRM market of whoever was bound to
 * it. Bindings (prospect_benchmarks) are then classified against the run's
 * geography: a prospect from another market bound to the run is a
 * contamination of the display-name collision and stays REVIEW_REQUIRED;
 * the release gate BENCHMARK_MARKET_VERIFIED blocks it structurally.
 *
 *   npx tsx scripts/wilmington-reconcile.ts --project <id>            # classify
 *   npx tsx scripts/wilmington-reconcile.ts --project <id> --apply    # bind when every run agrees
 *
 * --apply binds projects.market_id to the single market every run's prompts
 * name, and relabels the project. It refuses when runs disagree or when any
 * run's prompts name no state at all (ambiguous → founder decision).
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { marketBenchmarkProjectName } from "@/lib/markets/bootstrap";
import { stateCodeFor, statePattern, US_STATE_NAMES } from "@/lib/markets/geography";

type Geo = { marketId: string; name: string; stateCode: string; stateName: string };
type RunClass = { runId: string; status: string; label: string | null; responses: number; prompts: number; hits: Record<string, number>; verdict: string };

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

/** Candidate markets = launched markets sharing the project's bare city name. */
async function candidates(projectName: string): Promise<Geo[]> {
  const city = projectName.replace(/^Market benchmark:\s*/, "").split(",")[0]!.trim();
  const rows = await sql`
    select m.id, m.name, m.state_code from markets m
    where lower(m.name) = lower(${city}) and m.state_code is not null
      and exists (select 1 from market_launches l where l.market_id = m.id)
  `;
  return rows.map((r) => ({ marketId: r.id as string, name: r.name as string, stateCode: r.stateCode as string, stateName: US_STATE_NAMES[r.stateCode as string] ?? (r.stateCode as string) }));
}

/** Frozen prompts naming exactly one candidate state ⇒ SAFE_<state>. Counted in SQL over the immutable frozen_prompts. */
async function classifyRuns(projectId: string, geos: Geo[]): Promise<RunClass[]> {
  const runs = await sql`
    select r.id, r.status, r.label, r.prompt_set_version_id, (select count(*)::int from responses x where x.run_id = r.id) as responses,
      (select count(*)::int from prompt_set_versions v, jsonb_array_elements(v.frozen_prompts) p where v.id = r.prompt_set_version_id) as prompts
    from runs r where r.project_id = ${projectId} order by r.started_at
  `;
  const out: RunClass[] = [];
  for (const r of runs) {
    const hits: Record<string, number> = {};
    for (const g of geos) {
      const [h] = await sql`
        select count(*)::int as n from prompt_set_versions v, jsonb_array_elements(v.frozen_prompts) p
        where v.id = ${r.promptSetVersionId} and (p->>'text') ~* ${statePattern(g.stateCode)}
      `;
      hits[g.stateCode] = Number(h?.n ?? 0);
    }
    const named = Object.entries(hits).filter(([, n]) => n > 0).map(([s]) => s);
    const verdict = named.length === 1 ? `SAFE_${named[0]}` : named.length === 0 ? "AMBIGUOUS_NO_STATE_IN_PROMPTS" : "AMBIGUOUS_MULTIPLE_STATES";
    out.push({ runId: r.id as string, status: r.status as string, label: (r.label as string | null) ?? null, responses: Number(r.responses), prompts: Number(r.prompts), hits, verdict });
  }
  return out;
}

async function classifyBindings(projectId: string, runClasses: RunClass[]) {
  const rows = await sql`
    select pb.run_id, m.state_code, count(distinct pb.prospect_id)::int as prospects,
      count(distinct pb.prospect_id) filter (where exists (select 1 from prospect_outreach_sends s where s.prospect_id = pb.prospect_id))::int as with_sends,
      count(distinct pb.prospect_id) filter (where exists (select 1 from prospect_audits a where a.prospect_id = pb.prospect_id and a.status = 'published'))::int as with_published_audits
    from prospect_benchmarks pb join runs r on r.id = pb.run_id join prospects pr on pr.id = pb.prospect_id
    join market_launches l on l.id = pr.launch_id join markets m on m.id = l.market_id
    where r.project_id = ${projectId} group by 1, 2 order by 1, 2
  `;
  return rows.map((b) => {
    const run = runClasses.find((r) => r.runId === b.runId);
    const runState = run?.verdict.startsWith("SAFE_") ? run.verdict.slice(5) : null;
    const verdict = runState === null ? "REVIEW_REQUIRED_RUN_AMBIGUOUS" : runState === b.stateCode ? `SAFE_${runState}` : "REVIEW_REQUIRED_CROSS_MARKET";
    return { runId: b.runId, prospectState: b.stateCode, prospects: b.prospects, withSends: b.withSends, withPublishedAudits: b.withPublishedAudits, verdict };
  });
}

async function main(): Promise<void> {
  const projectId = arg("--project");
  if (!projectId) throw new Error("--project <id> is required");
  const [project] = await sql`select id, name, market_id from projects where id = ${projectId}`;
  if (!project) throw new Error("project not found");
  const geos = await candidates(project.name as string);
  const runs = await classifyRuns(projectId, geos);
  const bindings = await classifyBindings(projectId, runs);
  const [pack] = await sql`
    select payload->'hierarchy'->>'name' as hierarchy from market_pack_drafts
    where status = 'installed' and payload->>'cityName' ilike ${(project.name as string).replace(/^Market benchmark:\s*/, "").split(",")[0]!.trim() + "%"}
    order by created_at desc limit 1
  `;
  const states = [...new Set(runs.filter((r) => r.responses > 0 || r.status === "completed").map((r) => r.verdict))];
  const unanimous = states.length === 1 && states[0]!.startsWith("SAFE_") ? states[0]!.slice(5) : null;
  const target = unanimous ? geos.find((g) => g.stateCode === unanimous) ?? null : null;
  const packAgrees = target ? stateCodeFor(String(pack?.hierarchy ?? "")) === target.stateCode : false;
  const decision = target && packAgrees ? `BIND_${target.stateCode}` : "REVIEW_REQUIRED";

  console.log(JSON.stringify({
    project: { id: project.id, name: project.name, marketId: project.marketId },
    candidates: geos, installedPackHierarchy: pack?.hierarchy ?? null,
    runs, bindings, decision,
    note: "run geography = frozen prompt text (immutable); bindings from another market stay REVIEW_REQUIRED and are blocked by BENCHMARK_MARKET_VERIFIED",
  }, null, 1));

  if (process.argv.includes("--apply")) {
    if (!target || !packAgrees) { console.log("APPLY REFUSED: runs or pack do not agree on one state"); process.exitCode = 2; return; }
    if (project.marketId && project.marketId !== target.marketId) { console.log("APPLY REFUSED: project already bound to a different market"); process.exitCode = 2; return; }
    const [operator] = await sql`select id from users where email = 'zulumanf@gmail.com'`;
    await sql.begin(async (tx) => {
      await tx`update projects set market_id = ${target.marketId}, name = ${marketBenchmarkProjectName(target.name, target.stateCode)} where id = ${projectId}`;
      await writeAudit(tx, {
        userId: (operator?.id as string) ?? null,
        action: "project.market_bound",
        entity: "project",
        entityId: projectId,
        detail: { marketId: target.marketId, state: target.stateCode, runs: runs.map((r) => ({ runId: r.runId, verdict: r.verdict })), crossMarketBindings: bindings.filter((b) => b.verdict.startsWith("REVIEW")).map((b) => ({ runId: b.runId, state: b.prospectState, prospects: b.prospects })), reconciliation: "wilmington-reconcile 2026-09-14" },
      });
    });
    console.log(JSON.stringify({ applied: { projectId, marketId: target.marketId, name: marketBenchmarkProjectName(target.name, target.stateCode) } }, null, 1));
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => sql.end());
