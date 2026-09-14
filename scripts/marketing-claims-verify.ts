/**
 * Marketing claims verifier. Recounts every claim in
 * `lib/marketing/approved-claims.json` from the immutable measurement tables
 * using the same eligibility rules as scoring (valid cells, non-holdout
 * prompts, current mention revisions, echo exclusion) and reports drift.
 *
 *   npx tsx scripts/marketing-claims-verify.ts            # print recomputed values
 *   npx tsx scripts/marketing-claims-verify.ts --check    # exit 1 on drift vs registry
 *
 * Read-only. A claim whose numbers drift is not silently updated: the
 * operator re-reads the evidence, edits the registry and bumps last_verified.
 *
 * Release gates (spec 141), each printed as PASS / FAIL / INTEGRITY /
 * MANUAL REVIEW and any of the last three makes `--check` exit 1:
 *  - value drift against the public-precedence recount (FAIL)
 *  - a (response, company) pair in the claim's run that needs manual review (MANUAL REVIEW)
 *  - a heuristic re-parse superseding a verified row with no adjudication (INTEGRITY)
 *  - denominator differing from the canonical eligibility count (FAIL)
 *  - missing source run / date / market / instrument (FAIL)
 *  - public dataset rows disagreeing with the registry (FAIL)
 *  - banned wording in registry or marketing sources (FAIL)
 * Pending claims are skipped (not public) unless --include-pending.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { PUBLIC_REVISION, PUBLIC_BLOCKED_PAIR } from "@/db/mentions";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { findBannedWording } from "@/lib/marketing/wording";
import { PARSER_VERSION_ADJUDICATION, PARSER_VERSION_HEURISTIC } from "@/lib/constants";
import { PROMPT_ECHO_EXCLUDED } from "@/lib/scoring/prompt-echo";
import { providerRecommendationCounts } from "@/lib/prospects/benchmark";
import { APPROVED_CLAIMS, REGISTRY_META as registryMeta, type ApprovedClaim, type ClaimValues } from "@/lib/marketing/claims";

const PUBLIC_PROVIDERS = ["openai", "perplexity"] as const;

/** Valid, non-holdout answers of a run (canonical eligibility). */
const validAnswers = (runId: string) => sql`
  select x.id, x.provider
  from responses x
  join runs r2 on r2.id = x.run_id
  join prompt_set_versions v on v.id = r2.prompt_set_version_id
  join lateral jsonb_to_recordset(v.frozen_prompts) as p("promptId" uuid, "isHoldout" boolean)
    on p."promptId" = x.prompt_id
  where x.run_id = ${runId} and x.error is null and coalesce(x.refusal, false) = false
    and coalesce(p."isHoldout", false) = false`;

async function runSummary(runId: string): Promise<ClaimValues> {
  const [row] = await sql`
    with a as (${validAnswers(runId)})
    select count(*)::int as answers,
      (select count(*)::int from responses where run_id = ${runId}) as captured,
      count(*) filter (where exists (
        select 1 from mentions m join companies c on c.id = m.company_id
        join responses r on r.id = m.response_id
        where m.response_id = a.id and m.recommended and ${PUBLIC_REVISION} and ${PROMPT_ECHO_EXCLUDED}))::int as answers_with_recommendation,
      (select count(distinct m.company_id)::int from mentions m join a on a.id = m.response_id
        join companies c on c.id = m.company_id join responses r on r.id = m.response_id
        where m.recommended and ${PUBLIC_REVISION} and ${PROMPT_ECHO_EXCLUDED}) as entities_recommended,
      (select count(*)::int from (select distinct c.response_id, c.domain from response_citations c join a on a.id = c.response_id) d) as answer_domain_pairs,
      (select count(distinct c.domain)::int from response_citations c join a on a.id = c.response_id) as domains,
      (select jsonb_array_length(v.frozen_prompts) from runs r2 join prompt_set_versions v on v.id = r2.prompt_set_version_id where r2.id = ${runId}) as prompts,
      (select count(*)::int from mentions m join a a2 on a2.id = m.response_id where ${PUBLIC_BLOCKED_PAIR}) as blocked_pairs
    from a`;
  return row as ClaimValues;
}

async function runByProvider(runId: string): Promise<ClaimValues> {
  const rows = await sql`
    with a as (${validAnswers(runId)})
    select a.provider, count(*)::int as answers,
      count(*) filter (where exists (select 1 from response_citations c where c.response_id = a.id))::int as answers_with_citation,
      count(*) filter (where exists (select 1 from mentions m join companies c on c.id = m.company_id join responses r on r.id = m.response_id
        where m.response_id = a.id and m.recommended and ${PUBLIC_REVISION} and ${PROMPT_ECHO_EXCLUDED}))::int as answers_with_recommendation,
      (select count(distinct m.company_id)::int from mentions m join a a2 on a2.id = m.response_id
        join companies c on c.id = m.company_id join responses r on r.id = m.response_id
        where a2.provider = a.provider and m.recommended and ${PUBLIC_REVISION} and ${PROMPT_ECHO_EXCLUDED}) as entities_recommended,
      (select max(n)::int from (select count(distinct m.response_id) n from mentions m join a a2 on a2.id = m.response_id
        join companies c on c.id = m.company_id join responses r on r.id = m.response_id
        where a2.provider = a.provider and m.recommended and ${PUBLIC_REVISION} and ${PROMPT_ECHO_EXCLUDED} group by m.company_id) t) as top_entity_recommendations,
      (select count(*)::int from mentions m join a a2 on a2.id = m.response_id where a2.provider = a.provider and ${PUBLIC_BLOCKED_PAIR}) as blocked_pairs
    from a group by a.provider`;
  const out: ClaimValues = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r)) if (k !== "provider") out[`${r.provider}_${k}`] = Number(v);
  }
  return out;
}

async function runTopDomains(runId: string, limit: number): Promise<ClaimValues> {
  const rows = await sql`
    with a as (${validAnswers(runId)}),
    d as (select distinct c.response_id, c.domain from response_citations c join a on a.id = c.response_id)
    select domain, count(*)::int as n from d group by 1 order by 2 desc, 1 limit ${limit}`;
  return Object.fromEntries(rows.map((r) => [`domain:${r.domain}`, Number(r.n)]));
}

/** Corpus-wide aggregate over real-estate market benchmarks: public providers,
 * completed/partial runs, excluding QA fixtures and non-real-estate projects. */
const corpusRuns = (through: string) => sql`
  select r.id from runs r join projects pr on pr.id = r.project_id
  where r.status in ('completed', 'partial') and r.label not like 'QA%' and pr.name <> 'Parva Core'
    and coalesce(r.completed_at, r.started_at) < (${through}::date + 1)`;

async function corpusAggregate(through: string): Promise<ClaimValues> {
  const CORPUS_RUNS = corpusRuns(through);
  const rows = await sql`
    with a as (
      select x.id, x.provider, x.run_id, x.requested_at, r.project_id from responses x join runs r on r.id = x.run_id
      where r.id in (${CORPUS_RUNS}) and x.provider in ${sql(PUBLIC_PROVIDERS as unknown as string[])}
        and x.error is null and coalesce(x.refusal, false) = false and x.requested_at < (${through}::date + 1))
    select a.provider, count(*)::int as answers,
      count(*) filter (where exists (select 1 from mentions m join companies c on c.id = m.company_id join responses r on r.id = m.response_id
        where m.response_id = a.id and m.recommended and ${PUBLIC_REVISION} and ${PROMPT_ECHO_EXCLUDED}))::int as answers_with_recommendation,
      count(*) filter (where exists (select 1 from response_citations c where c.response_id = a.id))::int as answers_with_citation,
      count(distinct a.run_id)::int as runs, count(distinct a.project_id)::int as projects
    from a group by a.provider`;
  const out: ClaimValues = {};
  for (const r of rows) for (const [k, v] of Object.entries(r)) if (k !== "provider") out[`${r.provider}_${k}`] = typeof v === "number" ? v : String(v);
  const [tot] = await sql`
    with a as (select x.id, x.run_id, r.project_id from responses x join runs r on r.id = x.run_id
      where r.id in (${CORPUS_RUNS}) and x.provider in ${sql(PUBLIC_PROVIDERS as unknown as string[])} and x.error is null and coalesce(x.refusal, false) = false and x.requested_at < (${through}::date + 1)),
    d as (select distinct c.response_id, c.domain from response_citations c join a on a.id = c.response_id)
    select count(*)::int as answer_domain_pairs, count(distinct domain)::int as domains,
      (select count(distinct project_id)::int from a) as projects,
      (select count(distinct run_id)::int from a) as runs
    from d`;
  return { ...out, ...(tot as ClaimValues) };
}

async function corpusTopDomains(limit: number, through: string): Promise<ClaimValues> {
  const CORPUS_RUNS = corpusRuns(through);
  const rows = await sql`
    with a as (select x.id, x.provider from responses x join runs r on r.id = x.run_id
      where r.id in (${CORPUS_RUNS}) and x.provider in ${sql(PUBLIC_PROVIDERS as unknown as string[])} and x.error is null and coalesce(x.refusal, false) = false and x.requested_at < (${through}::date + 1)),
    d as (select distinct c.response_id, c.domain, a.provider from response_citations c join a on a.id = c.response_id)
    select domain, count(*)::int as n, count(*) filter (where provider = 'openai')::int as oa, count(*) filter (where provider = 'perplexity')::int as px
    from d group by 1 order by 2 desc, 1 limit ${limit}`;
  const out: ClaimValues = {};
  for (const r of rows) { out[`domain:${r.domain}`] = Number(r.n); out[`domain:${r.domain}:openai`] = Number(r.oa); out[`domain:${r.domain}:perplexity`] = Number(r.px); }
  return out;
}

/** Source-class distribution over answer-domain pairs, using the stored
 * `sources.source_type` label per domain (unlabelled = 'other'). */
async function corpusSourceClasses(through: string): Promise<ClaimValues> {
  const CORPUS_RUNS = corpusRuns(through);
  const rows = await sql`
    with a as (select x.id from responses x join runs r on r.id = x.run_id
      where r.id in (${CORPUS_RUNS}) and x.provider in ${sql(PUBLIC_PROVIDERS as unknown as string[])} and x.error is null and coalesce(x.refusal, false) = false and x.requested_at < (${through}::date + 1)),
    d as (select distinct c.response_id, c.domain from response_citations c join a on a.id = c.response_id),
    t as (select domain, min(source_type) as source_type from sources group by domain)
    select coalesce(t.source_type, 'other') as source_class, count(*)::int as pairs, count(distinct d.domain)::int as domains
    from d left join t on t.domain = d.domain group by 1 order by 2 desc`;
  const out: ClaimValues = {};
  for (const r of rows) { out[`class:${r.sourceClass}:pairs`] = Number(r.pairs); out[`class:${r.sourceClass}:domains`] = Number(r.domains); }
  return out;
}

/** Prompt-category coverage: frozen prompts across corpus runs, by category. */
async function corpusPromptCategories(through: string): Promise<ClaimValues> {
  const CORPUS_RUNS = corpusRuns(through);
  const rows = await sql`
    select e->>'category' as category, count(*)::int as prompts, count(distinct r.id)::int as runs
    from runs r join prompt_set_versions v on v.id = r.prompt_set_version_id, jsonb_array_elements(v.frozen_prompts) e
    where r.id in (${CORPUS_RUNS}) group by 1 order by 2 desc`;
  const out: ClaimValues = {};
  for (const r of rows) { out[`category:${r.category}:prompts`] = Number(r.prompts); out[`category:${r.category}:runs`] = Number(r.runs); }
  return out;
}

/** Production-vs-recommendation contrast: canonical per-provider counts for two
 * named companies, plus their RealTrends volumes (same year) — anonymized on
 * the public side, exact here so a person can re-check the receipt. */
async function productionContrast(runId: string, subjectCompany: string, rivalCompany: string): Promise<ClaimValues> {
  const ids = await sql`select id, name from companies where name in (${subjectCompany}, ${rivalCompany})`;
  const byName = Object.fromEntries(ids.map((r) => [r.name as string, r.id as string]));
  const out: ClaimValues = {};
  for (const provider of PUBLIC_PROVIDERS) {
    const counts = await providerRecommendationCounts(runId, provider, Object.values(byName));
    out[`${provider}_answers`] = counts.answerCount;
    out[`${provider}_subject_recommended`] = counts.recommendedByCompany[byName[subjectCompany] ?? ""] ?? 0;
    out[`${provider}_rival_recommended`] = counts.recommendedByCompany[byName[rivalCompany] ?? ""] ?? 0;
  }
  const vols = await sql`select company_id, max(volume_usd)::bigint as vol, max(production_year)::int as yr from realtrends_records
    where company_id in (${byName[subjectCompany] ?? null}, ${byName[rivalCompany] ?? null}) group by 1`;
  for (const v of vols) {
    const key = v.companyId === byName[subjectCompany] ? "subject" : "rival";
    out[`${key}_volume_usd`] = Number(v.vol); out[`${key}_production_year`] = Number(v.yr);
  }
  const [rank] = await sql`select count(*)::int as n_teams_with_record,
      (select count(*)::int from prospects p join prospect_benchmarks pb on pb.prospect_id = p.id join realtrends_records rt on rt.company_id = p.company_id
        where pb.run_id = ${runId} and rt.volume_usd > (select max(volume_usd) from realtrends_records where company_id = ${byName[subjectCompany] ?? null})) as teams_above_subject
    from prospects p join prospect_benchmarks pb on pb.prospect_id = p.id join realtrends_records rt on rt.company_id = p.company_id where pb.run_id = ${runId}`;
  return { ...out, ...(rank as ClaimValues) };
}

/** Pairs in a run's valid answers whose newest classification needs manual
 * review (public precedence, lib/parsing/precedence.ts). */
async function blockedPairs(runId: string): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from mentions m join responses x on x.id = m.response_id
    where x.run_id = ${runId} and x.error is null and ${PUBLIC_BLOCKED_PAIR}`;
  return Number(row?.n ?? 0);
}

/** Integrity: pairs where the LATEST heuristic row is newer than the verified
 * row and disagrees with it, and no adjudication revision exists — a
 * downgraded re-parse nobody has looked at (same definition as the judge). */
async function unadjudicatedDowngrades(runId: string): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from mentions m join responses x on x.id = m.response_id
    where x.run_id = ${runId} and ${PUBLIC_REVISION}
      and exists (select 1 from (
          select distinct on (h.response_id, h.company_id) h.* from mentions h
          where h.response_id = m.response_id and h.company_id = m.company_id and h.parser_version = ${PARSER_VERSION_HEURISTIC}
          order by h.response_id, h.company_id, h.revision desc) h
        where h.revision > m.revision and (h.recommended <> m.recommended or h.mentioned <> m.mentioned))
      and not exists (select 1 from mentions a where a.response_id = m.response_id and a.company_id = m.company_id
        and a.parser_version = ${PARSER_VERSION_ADJUDICATION})`;
  return Number(row?.n ?? 0);
}

/** Blocked pairs across every corpus run (for corpus-level claims). */
async function corpusBlockedPairs(through: string): Promise<number> {
  const CORPUS_RUNS = corpusRuns(through);
  const [row] = await sql`
    select count(*)::int as n from mentions m join responses x on x.id = m.response_id
    where x.run_id in (${CORPUS_RUNS}) and x.error is null and ${PUBLIC_BLOCKED_PAIR}`;
  return Number(row?.n ?? 0);
}

/** Canonical eligibility denominator (valid, non-holdout) per provider. */
async function canonicalAnswers(runId: string): Promise<Record<string, number>> {
  const rows = await sql`
    with a as (${validAnswers(runId)}) select provider, count(*)::int as n from a group by 1`;
  return Object.fromEntries(rows.map((r) => [r.provider as string, Number(r.n)]));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|json|md)$/.test(f)) out.push(p);
  }
  return out;
}

/** Static wording scan over public sources and the registry. */
function wordingViolations(): string[] {
  const files = [...walk("app/(marketing)"), ...walk("lib/marketing"), ...walk("data/public")].filter((f) => !f.endsWith("approved-claims.json"));
  const out: string[] = [];
  for (const f of files) {
    const hit = findBannedWording(readFileSync(f, "utf8"));
    if (hit) out.push(`${f}: "${hit.match}" (${hit.why})`);
  }
  return out;
}

type DatasetRow = Record<string, unknown>;
function datasetRows(): { version: string; rows: DatasetRow[] } | null {
  try {
    const j = JSON.parse(readFileSync("data/public/real-estate-ai-visibility-benchmark.json", "utf8")) as { meta: { version: string }; benchmarks: DatasetRow[] };
    return { version: j.meta.version, rows: j.benchmarks };
  } catch { return null; }
}

/** Registry values the public dataset must reproduce for a run-based claim. */
function datasetMismatches(claim: ApprovedClaim, ds: { rows: DatasetRow[] }): string[] {
  const v = claim.verification;
  if (!("runId" in v) || v.query !== "run_by_provider") return [];
  const out: string[] = [];
  for (const provider of PUBLIC_PROVIDERS) {
    const row = ds.rows.find((r) => r.run_id === v.runId && r.provider === provider);
    if (!row) { out.push(`${provider}: no dataset row for run`); continue; }
    const pairs: [string, string][] = [["answers", "valid_answers"], ["answersWithRecommendation", "answers_with_recommendation"], ["entitiesRecommended", "distinct_entities_recommended"], ["topEntityRecommendations", "top_entity_recommendations"], ["answersWithCitation", "answers_with_citation"], ["blockedPairs", "blocked_pairs"]];
    for (const [k, col] of pairs) {
      const expected = claim.values[`${provider}_${k}`];
      if (expected !== undefined && String(row[col]) !== String(expected)) out.push(`${provider}.${col}: dataset=${row[col]} registry=${expected}`);
    }
  }
  return out;
}

async function compute(claim: ApprovedClaim): Promise<ClaimValues> {
  const v = claim.verification;
  switch (v.query) {
    case "run_summary": return runSummary(v.runId);
    case "run_by_provider": return runByProvider(v.runId);
    case "run_top_domains": return runTopDomains(v.runId, v.limit ?? 10);
    case "corpus_aggregate": return corpusAggregate(v.through);
    case "corpus_top_domains": return corpusTopDomains(v.limit ?? 20, v.through);
    case "corpus_source_classes": return corpusSourceClasses(v.through);
    case "corpus_prompt_categories": return corpusPromptCategories(v.through);
    case "production_contrast": return productionContrast(v.runId, v.subjectCompany, v.rivalCompany);
    case "manual": return {};
  }
}

/** The precedence fragments need migration 116; report that plainly. */
async function schemaReady(): Promise<boolean> {
  const [col] = await sql`select 1 from information_schema.columns where table_name = 'mentions' and column_name = 'verification_status'`;
  return Boolean(col);
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  if (!(await schemaReady())) {
    console.log("FAIL schema: migration 116_mention_verification_status is not applied to this database; apply migrations 115-116 (worker stopped) and the revision-3 artifact, then re-run");
    console.log("RELEASE GATE: 1 blocking issue(s)");
    await sql.end();
    process.exit(check ? 1 : 0);
  }
  const includePending = process.argv.includes("--include-pending");
  let failures = 0;
  const ds = datasetRows();
  const registryVersion = (registryMeta as { datasetVersion?: string }).datasetVersion;
  if (check && ds && registryVersion && ds.version !== registryVersion) { failures += 1; console.log(`FAIL dataset version ${ds.version} != registry datasetVersion ${registryVersion}`); }
  for (const claim of APPROVED_CLAIMS) {
    if (claim.status !== "approved" && !includePending) { console.log(`SKIP  ${claim.id} (${claim.status}, not public)`); continue; }
    const problems: string[] = [];
    const v = claim.verification;
    for (const k of ["benchmarkDate", "source", "market", "instrument"] as const) {
      if (!claim[k]) problems.push(`FAIL missing ${k}`);
    }
    if (findBannedWording(claim.publicWording)) problems.push(`FAIL banned wording in publicWording: ${findBannedWording(claim.publicWording)?.match}`);
    const actual = await compute(claim);
    const diffs = Object.entries(claim.values).filter(([k, expected]) => actual[k] !== undefined && String(actual[k]) !== String(expected));
    const missing = Object.keys(claim.values).filter((k) => actual[k] === undefined && v.query !== "manual");
    if (diffs.length) problems.push(`FAIL drift ${diffs.map(([k, e]) => `${k}: registry=${e} actual=${actual[k]}`).join("; ")}`);
    if (missing.length) problems.push(`FAIL missing values ${missing.join(",")}`);
    if ("runId" in v) {
      const blocked = await blockedPairs(v.runId);
      if (blocked > 0) problems.push(`MANUAL REVIEW ${blocked} pair(s) in run ${v.runId.slice(0, 8)} need manual review`);
      const downgrades = await unadjudicatedDowngrades(v.runId);
      if (downgrades > 0) problems.push(`INTEGRITY ${downgrades} verified pair(s) superseded by a disagreeing heuristic re-parse without adjudication`);
      if (v.query === "run_summary" || v.query === "run_by_provider") {
        const canon = await canonicalAnswers(v.runId);
        const total = Object.values(canon).reduce((a, b) => a + b, 0);
        if (v.query === "run_summary" && claim.values.answers !== undefined && Number(claim.values.answers) !== total) problems.push(`FAIL denominator ${claim.values.answers} != canonical ${total}`);
        if (v.query === "run_by_provider") for (const prov of PUBLIC_PROVIDERS) {
          const exp = claim.values[`${prov}_answers`];
          if (exp !== undefined && Number(exp) !== (canon[prov] ?? 0)) problems.push(`FAIL ${prov} denominator ${exp} != canonical ${canon[prov] ?? 0}`);
        }
      }
      if (ds) for (const m of datasetMismatches(claim, ds)) problems.push(`FAIL dataset ${m}`);
    } else if ("through" in v) {
      const blocked = await corpusBlockedPairs(v.through);
      if (blocked > 0) problems.push(`MANUAL REVIEW ${blocked} pair(s) across corpus runs need manual review`);
    }
    if (problems.length === 0) console.log(`PASS  ${claim.id}`);
    else { failures += 1; for (const pr of problems) console.log(`${pr.split(" ")[0] === "MANUAL" ? "MANUAL REVIEW" : pr.split(" ")[0]} ${claim.id}: ${pr.replace(/^(FAIL|INTEGRITY|MANUAL REVIEW) /, "")}`); }
    if (!check) console.log(JSON.stringify({ id: claim.id, actual }));
  }
  for (const w of wordingViolations()) { failures += 1; console.log(`FAIL wording ${w}`); }
  await sql.end();
  console.log(failures === 0 ? "RELEASE GATE: PASS" : `RELEASE GATE: ${failures} blocking issue(s)`);
  if (check && failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
