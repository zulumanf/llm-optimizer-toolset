/**
 * The Private AI Recommendation Report (spec 128 v2): everything a
 * competitive-mismatch prospect is shown after "Yes, send it", frozen into
 * the audit snapshot at publish time. Every figure comes from the same
 * frozen evidence the email cited; per-question rows are counted from the
 * run's captured answers (current revision, echo-excluded, non-holdout)
 * exactly like the recommendation counts. Every generated sentence is
 * typed: observed (counted), inference (may mean), recommendation (would
 * investigate). Sections whose evidence is missing are omitted, never
 * filled.
 */
import { sql } from "@/db/client";
import { CURRENT } from "@/lib/prospects/benchmark";
import { PROMPT_ECHO_EXCLUDED } from "@/lib/scoring/prompt-echo";
import { deliveredTouch1, prospectEntityType } from "@/lib/prospects/followups";
import { marketShortName, type MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { consumerAnchoredModelPhrase, providerDisplayName } from "@/lib/prospects/terminology";

export const PRIVATE_REPORT_TEMPLATE_VERSION = "private_ai_recommendation_report_v2";

export interface MismatchQuestionRow {
  text: string;
  /** False for frozen questions with a generator grammar slip ("sell a
   * condominiums"). They stay in every count and in the appendix, exactly
   * as asked; the executive sections show well-formed questions only. */
  wellFormed: boolean;
  audience: string;
  propertyType: string | null;
  neighborhood: string | null;
  luxury: boolean;
  answers: number;
  competitorRecommended: number;
  prospectRecommended: number;
  prospectMentioned: number;
  excerpts: { model: string; capturedAt: string; responseId: string; quote: string }[];
}

export interface CategoryCount {
  key: string;
  label: string;
  questions: number;
  prospect: number;
  competitor: number;
}

export interface DiagnosisArea {
  area: string;
  observed: string;
  mayMean: string;
  investigate: string;
}

export interface AuditMismatchBlock {
  templateVersion: string;
  prospect: { name: string; productionDisplay: string; productionYear: number | null; recommendationCount: number };
  competitor: { name: string; productionDisplay: string; productionYear: number | null; recommendationCount: number };
  productionSource: string;
  metricLabel: string;
  /** Truthful provider label ("OpenAI") — never the consumer app name: the
   * answers are API captures, not consumer ChatGPT sessions. */
  assistant: string;
  /** Prose form: "the OpenAI model behind ChatGPT". */
  assistantPhrase: string;
  /** Whether the model could search the web while answering. */
  webSearch: boolean;
  /** Valid answers the counts are out of — never rounded. */
  answerCount: number;
  questionCount: number;
  repetitions: number;
  capturedAt: string | null;
  /** Every non-holdout question, with counts; excerpts only where the
   * competitor was recommended. */
  questions: MismatchQuestionRow[];
  /** Distinct questions in which each party was recommended. */
  distinctQuestions: { prospect: number; competitor: number };
  categories: CategoryCount[];
  /** Categories where the competitor leads by the most, competitor ≥ 2. */
  gaps: CategoryCount[];
  /** Neighborhoods the competitor was recommended for, most first. */
  competitorNeighborhoods: string[];
  /** Where the answers pointed: domain + how often it was cited. */
  sources: { domain: string; citations: number; category: string | null }[] | null;
  ownSiteCited: boolean | null;
  diagnosis: DiagnosisArea[];
  priorities: { title: string; body: string }[];
  contextQuestions: string[];
  lessConcerned: { condition: string; status: string }[];
  note: { paragraphs: string[]; question: string | null };
  /** One line before the final ask: their context is the missing variable. */
  ctaBridge: string | null;
  /** RealTrends entity level of the prospect's frozen production record;
   * "you" vs "your team" everywhere on the page. Absent on pre-2026-09-04
   * snapshots (rendered as a team). */
  entityType?: "individual" | "team";
}

/** Second-person reference for the prospect: an individual agent is "you",
 * a team is "your team". */
export function entityRef(entityType: "individual" | "team" | null | undefined): { ref: string; Ref: string; yours: string; team: boolean } {
  const team = entityType !== "individual";
  return { ref: team ? "your team" : "you", Ref: team ? "Your team" : "You", yours: team ? "your team's" : "your", team };
}

const MAX_QUOTE = 240;
const MAX_EXCERPTS_PER_QUESTION = 2;
const GAP_MIN_COMPETITOR = 2;

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

/** Article + plural noun ("a condominiums", "a single-family homes"). */
export function isWellFormedQuestion(text: string): boolean {
  return !/\ban? (?:[a-z-]+ )?(?:condominiums|townhomes|homes|houses|condos|apartments|lofts|units)\b/i.test(text);
}

const AUDIENCE_LABEL: Record<string, string> = { buyer: "Buyer questions", seller: "Seller questions", general: "General “who should I use” questions" };
const PROPERTY_LABEL: Record<string, string> = { condominiums: "Condo questions", "single-family homes": "Single-family questions", townhomes: "Townhome questions" };

/** Raw counts per category. Pure. */
export function categorize(questions: MismatchQuestionRow[]): CategoryCount[] {
  const acc = new Map<string, CategoryCount>();
  const add = (key: string, label: string, q: MismatchQuestionRow): void => {
    const c = acc.get(key) ?? { key, label, questions: 0, prospect: 0, competitor: 0 };
    c.questions += 1;
    c.prospect += q.prospectRecommended;
    c.competitor += q.competitorRecommended;
    acc.set(key, c);
  };
  for (const q of questions) {
    add(`audience:${q.audience}`, AUDIENCE_LABEL[q.audience] ?? `${q.audience} questions`, q);
    if (q.propertyType) add(`property:${q.propertyType}`, PROPERTY_LABEL[q.propertyType] ?? `${q.propertyType} questions`, q);
    if (q.luxury) add("luxury", "Luxury questions", q);
    if (q.neighborhood) add("neighborhood", "Neighborhood questions", q);
  }
  return [...acc.values()].sort((a, b) => b.competitor - a.competitor || b.questions - a.questions);
}

export function gapCategories(categories: CategoryCount[]): CategoryCount[] {
  return categories
    .filter((c) => c.competitor >= GAP_MIN_COMPETITOR && c.competitor > c.prospect)
    .sort((a, b) => b.competitor - b.prospect - (a.competitor - a.prospect))
    .slice(0, 3);
}

function possessive(name: string): string {
  return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export interface NarrativeInput {
  prospect: AuditMismatchBlock["prospect"];
  competitor: AuditMismatchBlock["competitor"];
  market: string;
  answerCount: number;
  questions: MismatchQuestionRow[];
  categories: CategoryCount[];
  gaps: CategoryCount[];
  competitorNeighborhoods: string[];
  sources: AuditMismatchBlock["sources"];
  ownSiteCited: boolean | null;
  distinctQuestions: { prospect: number; competitor: number };
  entityType?: "individual" | "team" | null;
}

/** Diagnosis, priorities, context questions, less-concerned checks and the
 * note — all deterministic over the counted evidence, all personalized. */
export function narrative(i: NarrativeInput): Pick<AuditMismatchBlock, "diagnosis" | "priorities" | "contextQuestions" | "lessConcerned" | "note" | "ctaBridge"> {
  const p = i.prospect;
  const c = i.competitor;
  const { ref, team } = entityRef(i.entityType);
  const gapLead = i.gaps[0] ?? null;
  const gapLabels = i.gaps.map((g) => g.label.replace(" questions", "").toLowerCase());
  const nbhd = i.competitorNeighborhoods.slice(0, 3);
  const platforms = (i.sources ?? []).filter((s) => s.category === "platform").slice(0, 3).map((s) => s.domain);

  const diagnosis: DiagnosisArea[] = [];
  diagnosis.push({
    area: "Track record",
    observed: `Your ${p.productionDisplay} is well ahead of ${possessive(c.name)} ${c.productionDisplay} on the RealTrends record, but that advantage is not reflected in the answers: ${p.recommendationCount} recommendation${p.recommendationCount === 1 ? "" : "s"} for ${ref} against ${c.recommendationCount} for ${c.name}, out of the same ${i.answerCount} answers.`,
    mayMean: `${c.name} may have a clearer public trail connecting them with ${i.market} and the questions where they appeared.`,
    investigate: `How consistently your production, specialties, neighborhoods and ${team ? "team identity" : "name"} are represented across your own site and the independent websites that kept appearing in the answers.`,
  });
  if (gapLead) {
    diagnosis.push({
      area: "Where they show up",
      observed: `${gapLead.competitor} of ${possessive(c.name)} ${c.recommendationCount} recommendations came from ${gapLead.label.toLowerCase()}${nbhd.length ? `, most often about ${list(nbhd)}` : ""}; ${ref} had ${gapLead.prospect} there.`,
      mayMean: `${possessive(c.name)} name appears to be more strongly associated with ${gapLabels.length ? list(gapLabels) : "those searches"}${nbhd.length ? ` in ${list(nbhd)}` : ""} than yours is.`,
      investigate: `Why their name is tied to those specific searches: recent sales, listings and profiles that name ${nbhd.length ? list(nbhd) : "those areas"} explicitly.`,
    });
  }
  if (platforms.length > 0) {
    diagnosis.push({
      area: "Where the information comes from",
      observed: `The answers pointed to ${list(platforms)} again and again${i.ownSiteCited === false ? "; your own website was not one of them" : ""}.`,
      mayMean: `Those portal profiles appear to carry far more of the answers than either ${team ? "team's" : "agent's"} own website, which makes them one of the first places I'd inspect.`,
      investigate: `Whether ${team ? "your team, brokerage," : "you, your brokerage,"} neighborhoods and specialties read the same way on those portals as they do on your site.`,
    });
  }

  const priorities = [
    {
      title: "Make your track record easier to verify",
      body: `Your production is strong. I'd first check whether that record is represented as clearly and consistently online as ${possessive(c.name)} is.`,
    },
    ...(gapLead
      ? [{
          title: "Look at the questions where they keep coming up",
          body: `Most of the gap showed up in ${gapLead.label.toLowerCase()}${nbhd.length ? ` about ${list(nbhd)}` : ""}. I'd inspect why their name is more strongly tied to those searches.`,
        }]
      : []),
    ...(platforms.length > 0
      ? [{
          title: team ? "Make the team easy to understand everywhere" : "Make yourself easy to understand everywhere",
          body: `I'd check whether ${team ? "your agents, team, brokerage," : "your name, brokerage,"} neighborhoods and specialties are described the same way on ${list(platforms)} as on your own site.`,
        }]
      : []),
  ].slice(0, 3);

  const contextQuestions = [
    `Is ${c.name} someone you actually consider a direct competitor?`,
    ...(nbhd.length ? [`Are ${list(nbhd)} areas you actively want more business in?`] : []),
    "Which two or three neighborhoods or property types matter most to you this year?",
  ].slice(0, 3);

  const lessConcerned = [
    {
      condition: "the recommendations were concentrated in one unusual question",
      status: i.distinctQuestions.competitor <= 1
        ? `here they were: ${c.name} came up in only ${i.distinctQuestions.competitor} question, which is why I'd want your read on it`
        : `here they weren't: ${c.name} came up in ${i.distinctQuestions.competitor} different questions`,
    },
    {
      condition: `${ref} dominated the questions that matter most to your business`,
      status: i.distinctQuestions.prospect === 0
        ? `I can't see that from the outside; ${ref} ${team ? "was" : "were"} not recommended in any of the questions we asked`
        : `possible: ${ref} ${team ? "was" : "were"} recommended in ${i.distinctQuestions.prospect} question${i.distinctQuestions.prospect === 1 ? "" : "s"}, and only you know whether those are the ones that matter`,
    },
    {
      condition: `${c.name} isn't someone you actually compete with`,
      status: "only you can tell me that",
    },
  ];

  const ratio = c.productionDisplay && p.productionDisplay ? `${p.productionDisplay} against ${c.productionDisplay}` : "";
  const note = {
    paragraphs: [
      `The reason I reached out wasn't simply because ${ref} showed up less often.`,
      `It was because your production record is strong enough that the gap looked unusual: ${ratio} on the same RealTrends record, and ${p.recommendationCount} recommendation${p.recommendationCount === 1 ? "" : "s"} against ${c.recommendationCount}.`,
      `If the real-world numbers clearly favored ${c.name}, I probably wouldn't have contacted you. Here, they point in the opposite direction. That's what made this worth looking into.`,
    ],
    question: gapLead
      ? `The part I'd want to understand from you is whether ${gapLead.label.toLowerCase()}${nbhd.length ? ` in ${list(nbhd)}` : ""} are the part of the market you care about most.`
      : null,
  };

  const ctaBridge = nbhd.length
    ? `The main thing I'd want to understand from you is whether ${list(nbhd)} are actually the parts of ${i.market} you're trying to win. That changes what I'd work on first.`
    : `The main thing I'd want to understand from you is which parts of ${i.market} you're actually trying to win. That changes what I'd work on first.`;

  return { diagnosis, priorities, contextQuestions, lessConcerned, note, ctaBridge };
}

/** Every non-holdout question with counts; excerpts where the competitor
 * was recommended. */
export async function mismatchQuestions(s: MismatchEvidenceSnapshot): Promise<MismatchQuestionRow[]> {
  const rows = await sql`
    with fp as (
      select p."promptId" as prompt_id, coalesce(p."isHoldout", false) as is_holdout,
        p.audience, p."propertyType" as property_type, p.neighborhood, p."priceTier" as price_tier
      from runs r2 join prompt_set_versions v on v.id = r2.prompt_set_version_id,
      jsonb_to_recordset(v.frozen_prompts)
        as p("promptId" uuid, "isHoldout" boolean, audience text, "propertyType" text, neighborhood text, "priceTier" text)
      where r2.id = ${s.runId}
    ),
    r as (
      select x.id, x.prompt_id, x.prompt_text, x.model, x.requested_at, x.response_text,
        fp.audience, fp.property_type, fp.neighborhood, fp.price_tier
      from responses x join fp on fp.prompt_id = x.prompt_id
      where x.run_id = ${s.runId} and x.provider = ${s.provider} and x.error is null and not fp.is_holdout
    ),
    hits as (
      select r.*,
        exists (select 1 from mentions m join companies c on c.id = m.company_id
          where m.response_id = r.id and c.id = ${s.competitor.companyId} and m.recommended
            and ${CURRENT} and ${PROMPT_ECHO_EXCLUDED}) as comp,
        exists (select 1 from mentions m join companies c on c.id = m.company_id
          where m.response_id = r.id and c.id = ${s.prospect.companyId} and m.recommended
            and ${CURRENT} and ${PROMPT_ECHO_EXCLUDED}) as pros_rec,
        exists (select 1 from mentions m join companies c on c.id = m.company_id
          where m.response_id = r.id and c.id = ${s.prospect.companyId}
            and ${CURRENT} and ${PROMPT_ECHO_EXCLUDED}) as pros
      from r
    )
    select prompt_text, audience, property_type, neighborhood, price_tier, count(*)::int as answers,
      count(*) filter (where comp)::int as comp_n,
      count(*) filter (where pros_rec)::int as pros_rec_n,
      count(*) filter (where pros)::int as pros_n,
      coalesce(json_agg(json_build_object('id', id, 'model', model, 'at', requested_at, 'text', response_text)
        order by requested_at) filter (where comp), '[]') as comp_answers
    from hits
    group by prompt_id, prompt_text, audience, property_type, neighborhood, price_tier
    order by count(*) filter (where comp) desc, count(*) filter (where pros_rec) desc, prompt_text
  `;
  return rows.map((row) => {
    const answers = (row.compAnswers as { id: string; model: string; at: string; text: string }[]) ?? [];
    const excerpts: MismatchQuestionRow["excerpts"] = [];
    for (const a of answers) {
      const quote = excerptAround(a.text ?? "", s.competitor.name);
      if (quote) excerpts.push({ model: a.model, capturedAt: new Date(a.at).toISOString(), responseId: a.id, quote });
      if (excerpts.length >= MAX_EXCERPTS_PER_QUESTION) break;
    }
    const text = row.promptText as string;
    return {
      text,
      wellFormed: isWellFormedQuestion(text),
      audience: (row.audience as string | null) ?? "general",
      propertyType: (row.propertyType as string | null) ?? null,
      neighborhood: (row.neighborhood as string | null) ?? null,
      luxury: /\bluxury\b/i.test(text) || (row.priceTier as string | null) === "luxury",
      answers: Number(row.answers),
      competitorRecommended: Number(row.compN),
      prospectRecommended: Number(row.prosRecN),
      prospectMentioned: Number(row.prosN),
      excerpts,
    };
  });
}

export interface MismatchBlockContext {
  topSources?: { domain: string; citations: number; category?: string | null }[];
  ownSiteCited?: boolean | null;
}

/** Null when the prospect never received a mismatch Touch 1. */
export async function mismatchBlockForProspect(
  prospectId: string,
  ctx: MismatchBlockContext = {}
): Promise<AuditMismatchBlock | null> {
  const t1 = await deliveredTouch1(prospectId).catch(() => null);
  if (!t1) return null;
  const s = t1.evidenceSnapshot;
  const questions = await mismatchQuestions(s);
  const [meta] = await sql`
    select count(distinct prompt_id)::int as q, count(*)::int as n,
      count(*) filter (where request_params::text ilike '%web_search%')::int as ws
    from responses where run_id = ${s.runId} and provider = ${s.provider} and error is null
  `;
  const [marketRow] = await sql`
    select m.name from prospects p join market_launches l on l.id = p.launch_id join markets m on m.id = l.market_id where p.id = ${prospectId}
  `;
  const market = marketShortName((marketRow?.name as string | null) ?? "");
  const questionCount = Number(meta?.q ?? 0);
  const categories = categorize(questions);
  const gaps = gapCategories(categories);
  const nbhdCounts = new Map<string, number>();
  for (const q of questions) if (q.neighborhood && q.competitorRecommended > 0) nbhdCounts.set(q.neighborhood, (nbhdCounts.get(q.neighborhood) ?? 0) + q.competitorRecommended);
  const competitorNeighborhoods = [...nbhdCounts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
  const distinctQuestions = {
    prospect: questions.filter((q) => q.prospectRecommended > 0).length,
    competitor: questions.filter((q) => q.competitorRecommended > 0).length,
  };
  const sources = ctx.topSources?.length
    ? ctx.topSources.slice(0, 6).map((x) => ({ domain: x.domain, citations: x.citations, category: x.category ?? null }))
    : null;
  const prospect = { name: s.prospect.name, productionDisplay: s.prospect.productionDisplay, productionYear: s.prospect.productionYear, recommendationCount: s.prospect.recommendationCount };
  const competitor = { name: s.competitor.name, productionDisplay: s.competitor.productionDisplay, productionYear: s.competitor.productionYear, recommendationCount: s.competitor.recommendationCount };
  const entityType = await prospectEntityType(s);
  const story = narrative({
    prospect, competitor, market, answerCount: s.answerCount, questions, categories, gaps,
    competitorNeighborhoods, sources, ownSiteCited: ctx.ownSiteCited ?? null, distinctQuestions, entityType,
  });
  return {
    templateVersion: PRIVATE_REPORT_TEMPLATE_VERSION,
    ...(entityType ? { entityType } : {}),
    prospect,
    competitor,
    productionSource: "RealTrends (licensed, verified)",
    metricLabel: s.metricType === "sides" ? "closed sides" : "closed volume",
    assistant: providerDisplayName(s.provider),
    assistantPhrase: consumerAnchoredModelPhrase(s.provider, s.modelCount),
    webSearch: Number(meta?.ws ?? 0) > 0,
    answerCount: s.answerCount,
    questionCount,
    repetitions: questionCount > 0 ? Math.round(s.answerCount / questionCount) : 0,
    capturedAt: s.capturedAt,
    questions,
    distinctQuestions,
    categories,
    gaps,
    competitorNeighborhoods,
    sources,
    ownSiteCited: ctx.ownSiteCited ?? null,
    ...story,
  };
}
