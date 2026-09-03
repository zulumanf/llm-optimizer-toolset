/**
 * The "private report" a competitive-mismatch prospect was promised (spec
 * 128): the frozen Touch 1 comparison plus the exact questions and answers
 * behind it, frozen into the audit snapshot at publish time. Every figure
 * comes from the same frozen evidence the email cited; the per-question
 * rows are counted from the run's captured answers (current-revision,
 * echo-excluded, non-holdout) exactly like the recommendation counts.
 */
import { sql } from "@/db/client";
import { CURRENT } from "@/lib/prospects/benchmark";
import { PROMPT_ECHO_EXCLUDED } from "@/lib/scoring/prompt-echo";
import { deliveredTouch1 } from "@/lib/prospects/followups";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

export interface MismatchQuestionRow {
  text: string;
  answers: number;
  competitorRecommended: number;
  prospectMentioned: number;
  excerpts: { model: string; capturedAt: string; responseId: string; quote: string }[];
}

export interface AuditMismatchBlock {
  prospect: { name: string; productionDisplay: string; productionYear: number | null; recommendationCount: number };
  competitor: { name: string; productionDisplay: string; productionYear: number | null; recommendationCount: number };
  productionSource: string;
  assistant: string;
  answerCount: number;
  questionCount: number;
  repetitions: number;
  capturedAt: string | null;
  questions: MismatchQuestionRow[];
}

const ASSISTANT_LABELS: Record<string, string> = { openai: "ChatGPT", anthropic: "Claude", google: "Gemini", perplexity: "Perplexity" };
const MAX_QUOTE = 240;
const MAX_EXCERPTS_PER_QUESTION = 2;

/** The sentence around the first mention of `name`, markdown stripped. */
export function excerptAround(text: string, name: string): string | null {
  const plain = text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\(\s*\[[^\]]*\]\([^)]*\)\s*\)/g, "")
    .replace(/[*_#`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const idx = plain.toLowerCase().indexOf(name.toLowerCase());
  if (idx < 0) return null;
  const start = Math.max(0, plain.lastIndexOf(". ", idx) + 2, plain.lastIndexOf("\n", idx) + 1);
  const endDot = plain.indexOf(". ", idx + name.length);
  const end = endDot < 0 ? plain.length : endDot + 1;
  let quote = plain
    .slice(start, end)
    .replace(/^(\([a-z0-9.-]+\.[a-z]{2,}\)\s*)+/i, "")
    .replace(/^[-–•]\s*/, "")
    .replace(/\s*\([a-z0-9.-]+\.[a-z]{2,}\)/gi, "")
    .trim();
  if (quote.length > MAX_QUOTE) {
    const cut = Math.max(0, idx - start - 80);
    quote = `${cut > 0 ? "…" : ""}${quote.slice(cut, cut + MAX_QUOTE).trim()}…`;
  }
  return quote;
}

/** Frozen per-question rows for a snapshot. Only questions where either
 * party appeared are returned; the rest are silence for both. */
export async function mismatchQuestions(s: MismatchEvidenceSnapshot): Promise<MismatchQuestionRow[]> {
  const rows = await sql`
    with fp as (
      select p."promptId" as prompt_id, coalesce(p."isHoldout", false) as is_holdout
      from runs r2 join prompt_set_versions v on v.id = r2.prompt_set_version_id,
      jsonb_to_recordset(v.frozen_prompts) as p("promptId" uuid, "isHoldout" boolean)
      where r2.id = ${s.runId}
    ),
    r as (
      select x.id, x.prompt_id, x.prompt_text, x.model, x.requested_at, x.response_text
      from responses x join fp on fp.prompt_id = x.prompt_id
      where x.run_id = ${s.runId} and x.provider = ${s.provider} and x.error is null and not fp.is_holdout
    ),
    hits as (
      select r.id, r.prompt_id, r.prompt_text, r.model, r.requested_at, r.response_text,
        exists (select 1 from mentions m join companies c on c.id = m.company_id
          where m.response_id = r.id and c.id = ${s.competitor.companyId} and m.recommended
            and ${CURRENT} and ${PROMPT_ECHO_EXCLUDED}) as comp,
        exists (select 1 from mentions m join companies c on c.id = m.company_id
          where m.response_id = r.id and c.id = ${s.prospect.companyId}
            and ${CURRENT} and ${PROMPT_ECHO_EXCLUDED}) as pros
      from r
    )
    select prompt_text, count(*)::int as answers,
      count(*) filter (where comp)::int as comp_n, count(*) filter (where pros)::int as pros_n,
      coalesce(json_agg(json_build_object('id', id, 'model', model, 'at', requested_at, 'text', response_text)
        order by requested_at) filter (where comp), '[]') as comp_answers
    from hits
    group by prompt_id, prompt_text
    having count(*) filter (where comp) > 0 or count(*) filter (where pros) > 0
    order by count(*) filter (where comp) desc, count(*) filter (where pros) desc, prompt_text
  `;
  return rows.map((row) => {
    const answers = (row.compAnswers as { id: string; model: string; at: string; text: string }[]) ?? [];
    const excerpts: MismatchQuestionRow["excerpts"] = [];
    for (const a of answers) {
      const quote = excerptAround(a.text ?? "", s.competitor.name);
      if (quote) excerpts.push({ model: a.model, capturedAt: new Date(a.at).toISOString(), responseId: a.id, quote });
      if (excerpts.length >= MAX_EXCERPTS_PER_QUESTION) break;
    }
    return {
      text: row.promptText as string,
      answers: Number(row.answers),
      competitorRecommended: Number(row.compN),
      prospectMentioned: Number(row.prosN),
      excerpts,
    };
  });
}

/** Null when the prospect never received a mismatch Touch 1. */
export async function mismatchBlockForProspect(prospectId: string): Promise<AuditMismatchBlock | null> {
  const t1 = await deliveredTouch1(prospectId).catch(() => null);
  if (!t1) return null;
  const s = t1.evidenceSnapshot;
  const questions = await mismatchQuestions(s);
  const [meta] = await sql`
    select count(distinct prompt_id)::int as q, count(*)::int as n
    from responses where run_id = ${s.runId} and provider = ${s.provider} and error is null
  `;
  const questionCount = Number(meta?.q ?? 0);
  return {
    prospect: { name: s.prospect.name, productionDisplay: s.prospect.productionDisplay, productionYear: s.prospect.productionYear, recommendationCount: s.prospect.recommendationCount },
    competitor: { name: s.competitor.name, productionDisplay: s.competitor.productionDisplay, productionYear: s.competitor.productionYear, recommendationCount: s.competitor.recommendationCount },
    productionSource: "RealTrends (licensed, verified)",
    assistant: ASSISTANT_LABELS[s.provider] ?? s.provider,
    answerCount: s.answerCount,
    questionCount,
    repetitions: questionCount > 0 ? Math.round(s.answerCount / questionCount) : 0,
    capturedAt: s.capturedAt,
    questions,
  };
}
