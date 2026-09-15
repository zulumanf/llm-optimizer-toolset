/**
 * Public dataset export (spec 141 / docs/public_dataset_release.md).
 * Produces the anonymized, aggregate release under data/public/ from the
 * same corpus filter and eligibility rules as the marketing claims verifier.
 *
 *   npx tsx scripts/public-dataset-export.ts --through 2026-09-07 --version 1.0.0
 *
 * Anonymization rules (enforced here, documented in data/public/README.md):
 *  - only VERIFIED classifications count (public precedence, lib/parsing/precedence.ts);
 *    pairs needing manual review are excluded and reported as blocked_pairs;
 *  - no answer text, no prompt text, no entity names: entities are labelled
 *    E01.. per benchmark×provider in descending recommendation order;
 *  - a cited domain is named only if it was cited in at least
 *    MIN_MARKETS_FOR_NAMED_DOMAIN distinct market projects and is not owned
 *    by a tracked agent/team company; otherwise it is bucketed;
 *  - no RealTrends fields, no contacts, no run labels that name a prospect.
 * Read-only against the database.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { sql } from "@/db/client";
import { PUBLIC_REVISION, PUBLIC_BLOCKED_PAIR } from "@/db/mentions";
import { PROMPT_ECHO_EXCLUDED } from "@/lib/scoring/prompt-echo";
import { toCsv as csv } from "@/lib/marketing/public-dataset";

export const PUBLIC_DATASET_NAME = "real-estate-ai-visibility-benchmark";
export const MIN_MARKETS_FOR_NAMED_DOMAIN = 2;
export const DOMAIN_BUCKET_AGENT_OWNED = "agent_or_team_owned_site";
export const DOMAIN_BUCKET_SINGLE_MARKET = "single_market_domain";
const PUBLIC_PROVIDERS = ["openai", "perplexity"] as const;
const MODEL_LABELS: Record<string, string> = {
  openai: "the OpenAI model (gpt-5.4-mini, web search, API)",
  perplexity: "Perplexity (sonar, API)",
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : fallback;
}

/** Market label from the project name ("Market benchmark: Reno" → "Reno, NV"
 * is not derivable; keep the project's city label and the run's own market). */
function marketLabel(projectName: string, runLabel: string): string {
  const fromLabel = runLabel.match(/:\s*([A-Za-z.\s]+,\s*[A-Z]{2})/);
  if (fromLabel) return fromLabel[1]!.trim();
  if (/Delaware/.test(runLabel)) return "Wilmington, DE";
  if (/Jersey City|^JC /.test(projectName)) return "Jersey City, NJ";
  return projectName.replace(/^Market benchmark:\s*/, "").replace(/^Prospect benchmark:.*—\s*/, "");
}

async function main(): Promise<void> {
  const through = arg("through", "2026-09-07");
  const version = arg("version", "1.0.0");
  const outDir = arg("out", "data/public");
  mkdirSync(outDir, { recursive: true });

  const runs = await sql`
    select r.id, r.label, pr.name as project_name, r.status,
      (select jsonb_array_length(v.frozen_prompts) from prompt_set_versions v where v.id = r.prompt_set_version_id)::int as prompt_count,
      (select count(*) from jsonb_array_elements(v2.frozen_prompts) e where e->>'category' = 'recommendation')::int as recommendation_prompts
    from runs r join projects pr on pr.id = r.project_id
    join prompt_set_versions v2 on v2.id = r.prompt_set_version_id
    where r.status in ('completed', 'partial') and r.label not like 'QA%' and pr.name <> 'Parva Core'
      and coalesce(r.completed_at, r.started_at) < (${through}::date + 1)
    order by coalesce(r.completed_at, r.started_at), r.label`;

  // Domains cited across ≥ N market projects (namable); owner-linked domains are bucketed.
  const domainScope = await sql`
    select c.domain, count(distinct r.project_id)::int as projects,
      bool_or(c.company_id is not null and (exists (select 1 from prospects p where p.company_id = c.company_id)
        or exists (select 1 from realtrends_records rt where rt.company_id = c.company_id))) as agent_owned
    from response_citations c join responses x on x.id = c.response_id join runs r on r.id = x.run_id
    where r.id in ${sql(runs.map((r) => r.id as string))} group by 1`;
  const namable = new Map<string, string>();
  for (const d of domainScope) {
    namable.set(
      d.domain as string,
      d.agentOwned ? DOMAIN_BUCKET_AGENT_OWNED : Number(d.projects) >= MIN_MARKETS_FOR_NAMED_DOMAIN ? (d.domain as string) : DOMAIN_BUCKET_SINGLE_MARKET
    );
  }

  const benchmarks: Record<string, unknown>[] = [];
  const domains: Record<string, unknown>[] = [];
  const entities: Record<string, unknown>[] = [];
  let seq = 0;
  for (const run of runs) {
    for (const provider of PUBLIC_PROVIDERS) {
      const answers = sql`
        select x.id from responses x
        join prompt_set_versions v on v.id = (select prompt_set_version_id from runs where id = ${run.id})
        join lateral jsonb_to_recordset(v.frozen_prompts) as p("promptId" uuid, "isHoldout" boolean) on p."promptId" = x.prompt_id
        where x.run_id = ${run.id} and x.provider = ${provider} and x.error is null and coalesce(x.refusal, false) = false
          and coalesce(p."isHoldout", false) = false and x.requested_at < (${through}::date + 1)`;
      const [s] = await sql`
        with a as (${answers})
        select count(*)::int as valid_answers,
          (select count(*)::int from responses where run_id = ${run.id} and provider = ${provider}) as captured_calls,
          (select max(repetition)::int from responses where run_id = ${run.id} and provider = ${provider}) as repetition_count,
          max((select max(requested_at)::date::text from responses where run_id = ${run.id} and provider = ${provider})) as capture_date,
          count(*) filter (where exists (select 1 from mentions m join companies c on c.id = m.company_id join responses r on r.id = m.response_id
            where m.response_id = a.id and m.recommended and ${PUBLIC_REVISION} and ${PROMPT_ECHO_EXCLUDED}))::int as answers_with_recommendation,
          count(*) filter (where exists (select 1 from mentions m join companies c on c.id = m.company_id join responses r on r.id = m.response_id
            where m.response_id = a.id and m.mentioned and ${PUBLIC_REVISION} and ${PROMPT_ECHO_EXCLUDED}))::int as answers_with_mention,
          count(*) filter (where exists (select 1 from response_citations c where c.response_id = a.id))::int as answers_with_citation,
          (select count(*)::int from mentions m join a a2 on a2.id = m.response_id where ${PUBLIC_BLOCKED_PAIR}) as blocked_pairs
        from a`;
      if (!s || Number(s.validAnswers) === 0) continue;
      seq += 1;
      const benchmarkId = `RF-${String(seq).padStart(3, "0")}`;
      const ents = await sql`
        with a as (${answers})
        select count(distinct m.response_id)::int as recommended_in, count(distinct m.response_id) filter (where m.mentioned)::int as mentioned_in
        from mentions m join a on a.id = m.response_id join companies c on c.id = m.company_id join responses r on r.id = m.response_id
        where m.recommended and ${PUBLIC_REVISION} and ${PROMPT_ECHO_EXCLUDED} group by m.company_id order by 1 desc, 2 desc`;
      const doms = await sql`
        with a as (${answers}), d as (select distinct c.response_id, c.domain from response_citations c join a on a.id = c.response_id)
        select domain, count(*)::int as answers_citing from d group by 1`;
      const bucketed = new Map<string, number>();
      for (const d of doms) {
        const key = namable.get(d.domain as string) ?? DOMAIN_BUCKET_SINGLE_MARKET;
        bucketed.set(key, (bucketed.get(key) ?? 0) + Number(d.answersCiting));
      }
      const base = {
        benchmark_id: benchmarkId,
        market: marketLabel(run.projectName as string, run.label as string),
        provider,
        model_label: MODEL_LABELS[provider],
        capture_date: s.captureDate,
        run_id: run.id,
      };
      benchmarks.push({
        ...base,
        run_status: run.status,
        prompt_count: run.promptCount,
        recommendation_prompt_count: run.recommendationPrompts,
        repetition_count: s.repetitionCount,
        captured_calls: s.capturedCalls,
        valid_answers: s.validAnswers,
        answers_with_mention: s.answersWithMention,
        answers_with_recommendation: s.answersWithRecommendation,
        answers_with_citation: s.answersWithCitation,
        distinct_entities_recommended: ents.length,
        top_entity_recommendations: ents[0]?.recommendedIn ?? 0,
        blocked_pairs: s.blockedPairs,
      });
      ents.forEach((e, i) => {
        entities.push({ ...base, entity_label: `E${String(i + 1).padStart(2, "0")}`, recommended_in_answers: e.recommendedIn, mentioned_in_answers: e.mentionedIn, valid_answers: s.validAnswers });
      });
      for (const [domain, n] of [...bucketed.entries()].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))) {
        domains.push({ ...base, source_domain: domain, source_domain_is_bucket: domain === DOMAIN_BUCKET_AGENT_OWNED || domain === DOMAIN_BUCKET_SINGLE_MARKET, answers_citing: n, valid_answers: s.validAnswers });
      }
    }
  }
  const generated = new Date().toISOString().slice(0, 10);
  const meta = { dataset: PUBLIC_DATASET_NAME, version, generated, through, benchmarks: benchmarks.length, domain_rows: domains.length, entity_rows: entities.length, min_markets_for_named_domain: MIN_MARKETS_FOR_NAMED_DOMAIN, classification_precedence: "highest verified revision per (response, company); heuristic rows excluded; pairs needing manual review excluded and counted in blocked_pairs", blocked_pairs_total: benchmarks.reduce((n, b) => n + Number(b.blocked_pairs ?? 0), 0) };
  writeFileSync(`${outDir}/${PUBLIC_DATASET_NAME}.csv`, csv(benchmarks));
  writeFileSync(`${outDir}/${PUBLIC_DATASET_NAME}-domains.csv`, csv(domains));
  writeFileSync(`${outDir}/${PUBLIC_DATASET_NAME}-entities.csv`, csv(entities));
  writeFileSync(`${outDir}/${PUBLIC_DATASET_NAME}.json`, JSON.stringify({ meta, benchmarks, domains, entities }) + "\n");
  console.log(JSON.stringify(meta));
  await sql.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
