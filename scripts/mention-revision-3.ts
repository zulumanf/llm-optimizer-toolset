/**
 * Revision-3 adjudication (spec 141 / docs/parser_revision_comparison.md).
 *
 * Runs whose LLM classifications (mention-parser-v2+llm, revision 1) were
 * superseded by heuristic re-parses (mention-parser-v1+heuristic) get a
 * fresh, versioned classifier judgment on every (response, company) pair
 * where the two parsers disagree, or where only a heuristic row exists.
 * Pairs where both parsers agree need nothing: the verified classifier row
 * (the highest LLM revision at or above the review threshold) already wins
 * under the public precedence rule.
 *
 *   judge  — reads the source database, calls the classifier, writes an
 *            artifact (no database writes). `--offline` uses no classifier:
 *            the revision-1 judgment is kept only where the answer text
 *            corroborates it (lib/parsing/precedence.ts adjudicateOffline);
 *            pairs with no classifier judgment become not_classified.
 *            npx tsx scripts/mention-revision-3.ts judge [--runs id,id] --out data/internal/mention-revision-3/<name>.json
 *   apply  — inserts the artifact's rows as new mention revisions into the
 *            target database (idempotent per pair):
 *            npx tsx scripts/mention-revision-3.ts apply --artifact <file> [--db <url>]
 *
 * Nothing existing is modified: raw answers and every prior revision stay.
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import postgres from "postgres";
import { sql } from "@/db/client";
import { listCompaniesForProject } from "@/db/companies";
import { classifyResponseLlm, MENTION_CLASSIFIER_V2 } from "@/lib/parsing/classify-llm";
import { identityFactsFor } from "@/lib/prospects/entity-aliases";
import { modelForTask } from "@/lib/ai/routing";
import { adjudicate, adjudicateOffline, excerptGrounded, type Judgment, type VerificationStatus } from "@/lib/parsing/precedence";
import { scanAliases } from "@/lib/parsing/prepass";
import { PARSER_VERSION_ADJUDICATION, PARSER_VERSION_HEURISTIC, PARSER_VERSION_LLM } from "@/lib/constants";

export const ADJUDICATION_METHOD = "adjudication:rev1-llm+heuristic+fresh-classifier";
export const OFFLINE_ADJUDICATION_METHOD = "adjudication:offline-text-corroboration";
/** Retraction confidence used by the parse service for "no mention" rows. */
const NO_MENTION_CONFIDENCE = 0.85;

export type Rev3Row = {
  runId: string;
  responseId: string;
  companyId: string;
  llm1: Judgment | null;
  heuristic: Judgment | null;
  llm3: Judgment & { listPosition: number | null; sentiment: string; citedUrls: string[] };
  status: VerificationStatus;
  reason: string;
};

export type Rev3Artifact = {
  version: 1;
  parserVersion: string;
  method: string;
  classifierModel: string | null;
  classifierPromptVersion: string | null;
  classifierUnavailableReason?: string;
  judgedAt: string;
  sourceDatabaseHost: string;
  runs: { runId: string; label: string; responsesJudged: number; pairs: number }[];
  rows: Rev3Row[];
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** Runs whose current revision is heuristic while revision 1 was the LLM. */
export async function regressedRuns(): Promise<{ id: string; label: string; projectId: string }[]> {
  const rows = await sql`
    with per as (select x.run_id, m.revision, m.parser_version from mentions m join responses x on x.id = m.response_id group by 1, 2, 3),
    agg as (select run_id, bool_or(parser_version = ${PARSER_VERSION_LLM} and revision = 1) as llm1,
      (select parser_version from per p2 where p2.run_id = per.run_id order by revision desc limit 1) as currentv from per group by run_id)
    select r.id, r.label, r.project_id from agg a join runs r on r.id = a.run_id
    where a.llm1 and a.currentv = ${PARSER_VERSION_HEURISTIC} order by r.completed_at`;
  return rows.map((r) => ({ id: r.id as string, label: r.label as string, projectId: r.projectId as string }));
}

async function judge(): Promise<void> {
  const out = arg("out");
  if (!out) throw new Error("--out required");
  const wanted = arg("runs")?.split(",").map((s) => s.trim()).filter(Boolean);
  const all = await regressedRuns();
  const runs = wanted ? all.filter((r) => wanted.includes(r.id)) : all;
  const offline = process.argv.includes("--offline");
  const artifact: Rev3Artifact = {
    version: 1,
    parserVersion: PARSER_VERSION_ADJUDICATION,
    method: offline ? OFFLINE_ADJUDICATION_METHOD : ADJUDICATION_METHOD,
    classifierModel: offline ? null : modelForTask("mention_classification"),
    classifierPromptVersion: offline ? null : MENTION_CLASSIFIER_V2,
    ...(offline ? { classifierUnavailableReason: arg("reason") ?? "classifier unavailable" } : {}),
    judgedAt: new Date().toISOString(),
    sourceDatabaseHost: new URL(process.env.DATABASE_URL ?? "postgres://unknown").host,
    runs: [],
    rows: [],
  };
  for (const run of runs) {
    const companies = await listCompaniesForProject(run.projectId);
    const companyInputs = companies.map((c) => ({ id: c.id, name: c.name, aliases: c.aliases, domain: c.domain }));
    const claimRows = await sql`select canonical_text from claims where project_id = ${run.projectId} and status = 'approved' order by key asc`;
    const subject = companies.find((c) => c.isSelf);
    const identityContext: Record<string, string[]> = {
      ...(await identityFactsFor(companyInputs.map((c) => c.id))),
      ...(subject ? { [subject.id]: claimRows.map((c) => c.canonicalText as string) } : {}),
    };
    // Pairs to adjudicate: disagreement between rev-1 LLM and latest heuristic, or heuristic-only.
    const pairs = await sql`
      with l as (select distinct on (m.response_id, m.company_id) m.response_id, m.company_id, m.mentioned, m.recommended, m.confidence, m.excerpt from mentions m join responses x on x.id = m.response_id
        where x.run_id = ${run.id} and m.parser_version = ${PARSER_VERSION_LLM} and not m.needs_review and m.confidence >= 0.7
        order by m.response_id, m.company_id, m.revision desc),
      h as (select distinct on (m.response_id, m.company_id) m.response_id, m.company_id, m.mentioned, m.recommended, m.confidence from mentions m join responses x on x.id = m.response_id
        where x.run_id = ${run.id} and m.parser_version = ${PARSER_VERSION_HEURISTIC} order by m.response_id, m.company_id, m.revision desc)
      select coalesce(l.response_id, h.response_id) as response_id, coalesce(l.company_id, h.company_id) as company_id,
        l.mentioned as l_mentioned, l.recommended as l_recommended, l.confidence as l_confidence, l.excerpt as l_excerpt,
        h.mentioned as h_mentioned, h.recommended as h_recommended, h.confidence as h_confidence
      from l full join h on h.response_id = l.response_id and h.company_id = l.company_id
      where l.response_id is null or h.response_id is null or l.mentioned <> h.mentioned or l.recommended <> h.recommended`;
    const byResponse = new Map<string, (typeof pairs)[number][]>();
    for (const p of pairs) byResponse.set(p.responseId as string, [...(byResponse.get(p.responseId as string) ?? []), p]);
    let judged = 0;
    for (const [responseId, prs] of byResponse) {
      const [resp] = await sql`select response_text, prompt_text, error from responses where id = ${responseId}`;
      if (!resp || resp.error) continue;
      if (offline) {
        const text = (resp.responseText as string) ?? "";
        const hits = scanAliases(text, companyInputs);
        judged += 1;
        for (const p of prs) {
          const llm1 = p.lMentioned === null ? null : { mentioned: p.lMentioned as boolean, recommended: p.lRecommended as boolean, confidence: Number(p.lConfidence), excerpt: (p.lExcerpt as string | null) ?? null };
          const heuristic: Judgment | null = p.hMentioned === null ? null : { mentioned: p.hMentioned as boolean, recommended: p.hRecommended as boolean, confidence: Number(p.hConfidence) };
          const aliasInText = hits.some((h) => h.companyId === p.companyId);
          const excerptInText = excerptGrounded(text, llm1?.excerpt ?? null);
          const verdict = adjudicateOffline(llm1, { aliasInText, excerptInText });
          const retained = llm1 && verdict.status === "verified" ? llm1 : null;
          artifact.rows.push({
            runId: run.id, responseId, companyId: p.companyId as string, llm1: llm1 ? { mentioned: llm1.mentioned, recommended: llm1.recommended, confidence: llm1.confidence } : null, heuristic,
            llm3: { mentioned: retained?.mentioned ?? false, recommended: retained?.recommended ?? false, confidence: retained?.confidence ?? 0, listPosition: null, sentiment: "neutral", citedUrls: [] },
            status: verdict.status, reason: verdict.reason,
          });
        }
        continue;
      }
      const drafts = await classifyResponseLlm({
        responseText: (resp.responseText as string) ?? "",
        promptText: (resp.promptText as string) ?? "",
        companies: companyInputs,
        identityContext,
        projectId: run.projectId,
      });
      judged += 1;
      for (const p of prs) {
        const d = drafts.find((x) => x.companyId === p.companyId);
        const llm3 = d
          ? { mentioned: d.mentioned, recommended: d.recommended, confidence: d.confidence, listPosition: d.listPosition, sentiment: d.sentiment, citedUrls: d.citedUrls }
          : { mentioned: false, recommended: false, confidence: NO_MENTION_CONFIDENCE, listPosition: null, sentiment: "neutral", citedUrls: [] };
        const llm1: Judgment | null = p.lMentioned === null ? null : { mentioned: p.lMentioned as boolean, recommended: p.lRecommended as boolean, confidence: Number(p.lConfidence) };
        const heuristic: Judgment | null = p.hMentioned === null ? null : { mentioned: p.hMentioned as boolean, recommended: p.hRecommended as boolean, confidence: Number(p.hConfidence) };
        const verdict = adjudicate(llm1, heuristic, llm3);
        artifact.rows.push({ runId: run.id, responseId, companyId: p.companyId as string, llm1, heuristic, llm3, status: verdict.status, reason: verdict.reason });
      }
    }
    artifact.runs.push({ runId: run.id, label: run.label, responsesJudged: judged, pairs: pairs.length });
    console.log(`${run.label}: ${judged} responses judged, ${pairs.length} pairs`);
  }
  writeFileSync(out, JSON.stringify(artifact, null, 1) + "\n");
  const counts = artifact.rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {});
  console.log(JSON.stringify({ out, rows: artifact.rows.length, counts }));
  await sql.end();
}

async function apply(): Promise<void> {
  const file = arg("artifact");
  if (!file) throw new Error("--artifact required");
  const artifact = JSON.parse(readFileSync(file, "utf8")) as Rev3Artifact;
  const url = arg("db") ?? process.env.DATABASE_URL;
  if (!url) throw new Error("no target database");
  const db = postgres(url, { max: 2, transform: postgres.camel });
  let inserted = 0;
  let skipped = 0;
  for (const r of artifact.rows) {
    const [existing] = await db`select 1 from mentions where response_id = ${r.responseId} and company_id = ${r.companyId} and parser_version = ${artifact.parserVersion}`;
    if (existing) { skipped += 1; continue; }
    await db`
      insert into mentions (response_id, company_id, revision, mentioned, recommended, list_position, sentiment, excerpt, cited_urls,
        parser_version, confidence, needs_review, classifier_model, classifier_prompt_version,
        classification_method, classification_reason, verification_status)
      values (${r.responseId}, ${r.companyId},
        coalesce((select max(revision) from mentions where response_id = ${r.responseId} and company_id = ${r.companyId}), 0) + 1,
        ${r.llm3.mentioned}, ${r.llm3.recommended}, ${r.llm3.listPosition}, ${r.llm3.sentiment}, null, ${r.llm3.citedUrls},
        ${artifact.parserVersion}, ${r.llm3.confidence}, ${r.status === "needs_manual_review"}, ${artifact.classifierModel}, ${artifact.classifierPromptVersion},
        ${artifact.method}, ${r.reason}, ${r.status})`;
    await db`insert into response_parses (response_id, run_id, parser_version) values (${r.responseId}, ${r.runId}, ${artifact.parserVersion}) on conflict do nothing`;
    inserted += 1;
  }
  console.log(JSON.stringify({ target: new URL(url).host, inserted, skipped }));
  await db.end();
}

const cmd = process.argv[2];
(cmd === "judge" ? judge() : cmd === "apply" ? apply() : Promise.reject(new Error("usage: judge|apply"))).catch((e) => { console.error(e); process.exit(1); });
