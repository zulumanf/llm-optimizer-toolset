/**
 * Positive-reply report handoff (spec 129). A "yes" to a competitive-
 * mismatch touch becomes, without a human step: the private report
 * generated over the SAME frozen Touch 1 evidence (publishAudit), three QA
 * passes (deterministic evidence QA, an LLM read from the recipient's point
 * of view, the existing sense-check agent), and a threaded reply queued for
 * the existing gated dispatcher. Any failed check parks the handoff for the
 * founder with the reason. Every agent verdict is an insert-only row bound
 * to the content hash it judged.
 */
import { createHash } from "node:crypto";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import { log } from "@/lib/logger";
import type { CurrentUser } from "@/lib/auth";
import { runAgent, type AgentCaller } from "@/lib/ai/agent";
import { modelForTask } from "@/lib/ai/routing";
import { AUTOMATION_PROMPTS } from "@/lib/automation/prompts";
import {
  auditSenseCheck,
  reportProspectReview,
  type AuditSenseCheckOutput,
  type ReportProspectReviewOutput,
} from "@/lib/automation/nodes/agent";
import { checkSuppression } from "@/lib/outreach/suppression";
import {
  OUTREACH_PUBLIC_WEBSITE,
  PROSPECT_STAGES,
  REPORT_DELIVERY_TEMPLATE_VERSION,
  REPORT_HANDOFF,
  findProhibitedPhrase,
  type ReplyClassification,
} from "@/lib/prospects/constants";
import { deterministicOffsetMinutes, wallClock, zonedInstant } from "@/lib/prospects/business-days";
import {
  applySequenceSignals,
  firstNameFrom,
  footerTailFrom,
  prospectEntityType,
  sequenceForProspect,
  userById,
  type FollowupSequence,
} from "@/lib/prospects/followups";
import { lintFollowupCopy, prospectReference, type ProspectEntityType } from "@/lib/prospects/followup-templates";
import type { AuditMismatchBlock } from "@/lib/prospects/audit-mismatch";
import type { DraftQaIssue } from "@/lib/prospects/draft-qa";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { brandedAuditUrl } from "@/lib/prospects/urls";
import { logActivity } from "@/lib/prospects/shared";

export const HANDOFF_STATUSES = [
  "pending", "report_published", "qa_passed", "scheduled", "sent", "needs_review", "stopped",
] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

/** Replies that mean "send me the report" — the only trigger. */
export const HANDOFF_TRIGGER: ReplyClassification = "positive_interest";
/** A later reply of these kinds stops a handoff that has not sent. */
const HANDOFF_STOPPERS: ReplyClassification[] = ["unsubscribe", "not_interested"];

export function autosendEnabled(): boolean {
  return process.env.REPORT_HANDOFF_AUTOSEND !== "false";
}

export interface ReportHandoff {
  id: string;
  prospectId: string;
  replyId: string;
  sequenceId: string | null;
  auditId: string | null;
  draftId: string | null;
  status: HandoffStatus;
  reason: string | null;
  attempts: number;
  actorId: string | null;
}

function toHandoff(r: Record<string, unknown>): ReportHandoff {
  return {
    id: r.id as string,
    prospectId: r.prospectId as string,
    replyId: r.replyId as string,
    sequenceId: (r.sequenceId as string | null) ?? null,
    auditId: (r.auditId as string | null) ?? null,
    draftId: (r.draftId as string | null) ?? null,
    status: r.status as HandoffStatus,
    reason: (r.reason as string | null) ?? null,
    attempts: Number(r.attempts ?? 0),
    actorId: (r.actorId as string | null) ?? null,
  };
}

// ------------------------------------------------------------ pure: serialization

/** The report as the recipient reads it: the page's sections, in the page's
 * order, with the page's own explanatory sentences (counting rule, receipts
 * limited to well-formed questions, the full-question appendix, the overlap
 * note, the sources caption, the methodology). Both agents judge exactly this
 * string; its hash is stored with every verdict. Keep it in step with
 * components/audit/mismatch-report.tsx. */
export function serializeReportForReview(block: AuditMismatchBlock, ctx: { prospectName: string; market: string }): string {
  const out: string[] = [];
  const h = (t: string): void => { out.push("", `## ${t}`); };
  const you = block.entityType === "individual" ? "you" : "your team";
  const You = block.entityType === "individual" ? "You" : "Your team";
  const comp = block.competitor.name;
  const captured = block.capturedAt ? block.capturedAt.slice(0, 10) : null;
  const notFluke = block.distinctQuestions.competitor >= 3;
  out.push(
    `PRIVATE AI RECOMMENDATION REPORT · Recommended First · Prepared for ${ctx.prospectName} (${ctx.market}) · Private`,
    `Production source: RealTrends${block.prospect.productionYear ? ` ${block.prospect.productionYear}` : ""} · Test: ${block.questionCount} questions × ${block.repetitions} · Answers counted: ${block.answerCount}${captured ? ` · Answers recorded ${captured}` : ""}`
  );
  if (block.correction) out.push(block.correction.note);
  h("The finding");
  out.push(
    `RealTrends has ${you} ahead. AI recommends ${comp} more often.`,
    `On the RealTrends record for ${block.metricLabel}, ${you} ${block.entityType === "individual" ? "are" : "is"} ahead of ${comp}. In our ${ctx.market} test, ${comp} was recommended more often.`,
    `Figure 01 · Production vs AI recommendations`,
    `${block.prospect.productionYear ?? ""} ${block.metricLabel} (RealTrends): ${You} ${block.prospect.productionDisplay.replace(/ closed$/, "")} · ${comp} ${block.competitor.productionDisplay.replace(/ closed$/, "")}`,
    `AI recommendations, same ${ctx.market} test: ${You} ${block.prospect.recommendationCount} / ${block.answerCount} · ${comp} ${block.competitor.recommendationCount} / ${block.answerCount}`,
    `${You} closed more ${block.metricLabel.replace(/^closed /, "")}. ${comp} was recommended more.${notFluke ? ` ${comp} appeared across ${block.distinctQuestions.competitor} different questions.` : ""}`
  );
  if (block.changeFirst?.length) {
    h("What I'd change first");
    out.push(`Observed in the answers, the smallest change I'd make, and how the same test would show whether it moved. None of this is a ranking promise.`);
    for (const r of block.changeFirst) out.push(`- Observed: ${r.observed} · Change: ${r.change} · Test: ${r.test}`);
  }
  h("What we asked");
  out.push(
    `We tested the kinds of questions a buyer or seller might ask while deciding who to work with in ${ctx.market}.`,
    `We counted a team only when the answer actually recommended them, not simply when their name appeared.`,
    `Examples:`
  );
  for (const q of block.questions.filter((q) => q.wellFormed !== false).slice(0, 6)) out.push(`- "${q.text}"`);
  out.push(`View all ${block.questionCount} questions (expandable table; reproduced in the appendix below).`);
  const receipts = block.questions.filter((q) => q.excerpts.length > 0 && q.wellFormed !== false).slice(0, 4);
  if (receipts.length) {
    h("The receipts");
    out.push(`Every count in this report traces back to a saved answer: 01 Question → 02 Saved answer → 03 Recommendation recorded → 04 Count added to this report.`);
    for (const q of receipts) {
      const e = q.excerpts[0]!;
      out.push(
        ``, `Question: "${q.text}"`,
        `Saved answer: "${e.quote}"`,
        `Answer recorded ${e.capturedAt.slice(0, 10)} · ${block.assistant}`,
        `What we recorded: ${comp}: recommended (${q.competitorRecommended} of ${q.answers} answers) · ${block.prospect.name}: ${q.prospectRecommended === 0 ? "not recommended" : `recommended (${q.prospectRecommended} of ${q.answers})`}`
      );
    }
    out.push(`View all ${block.answerCount} saved answers (a link on the page opens every answer, exactly as it came back).`);
  }
  if (notFluke) {
    h("This wasn't based on one answer");
    out.push(
      `${comp}: ${block.competitor.recommendationCount} recommendations across ${block.distinctQuestions.competitor} different questions.`,
      `${You}: ${block.prospect.recommendationCount} recommendation${block.prospect.recommendationCount === 1 ? "" : "s"} across ${block.distinctQuestions.prospect} different question${block.distinctQuestions.prospect === 1 ? "" : "s"}.`
    );
    if (block.categories.length) {
      out.push(`Figure 02 · Recommendations by question type (Question type · Questions tested · ${You} recommendations · ${comp} recommendations)`);
      for (const c of block.categories) out.push(`- ${c.label} · ${c.questions} · ${c.prospect} · ${c.competitor}`);
      out.push(`Counts are recommendations, not questions. One question can belong to several types (selling a condo in a named neighborhood counts as seller, condo and neighborhood), so the rows overlap and do not add up to ${block.questionCount}.`);
    }
  }
  if (block.gaps.length) {
    h("Where they're showing up more");
    for (const g of block.gaps) out.push(`${g.label}: ${You} ${g.prospect} · ${comp} ${g.competitor}`);
    if (block.competitorNeighborhoods.length) out.push(`Neighborhoods where ${comp} was recommended: ${block.competitorNeighborhoods.join(", ")}.`);
  }
  if (block.sources?.length) {
    h("Where the information is coming from");
    out.push(
      `We also recorded the websites that appeared repeatedly in the answers.`,
      `We can see which websites keep appearing. We cannot say that any one of them caused a recommendation.`,
      `Figure 03 · Websites the answers pointed to · how many times, across all ${block.answerCount} answers (one answer can point to several websites)`
    );
    for (const s of block.sources) out.push(`- ${s.domain}${s.category === "competitor" ? " (competitor-owned)" : ""} · ${s.citations}`);
    if (block.ownSiteCited === false) out.push(`Your own website was not one of them.`);
  }
  h("Why this may be happening");
  for (const d of block.diagnosis) out.push(`${d.area} · What we observed: ${d.observed} · What it may mean: ${d.mayMean} · Worth checking: ${d.investigate}`);
  h("What I'd look at first");
  for (const p of block.priorities) out.push(`${p.title}: ${p.body}`);
  if (block.contextQuestions.length) {
    h("What I can't tell from public data");
    out.push(`The report can show me where the gap is. It can't tell me which parts of the market matter most to ${you}. Those answers would change what I'd prioritize first.`);
    for (const q of block.contextQuestions) out.push(`- ${q}`);
  }
  if (block.lessConcerned.length) {
    h("What would make me less concerned");
    for (const l of block.lessConcerned) out.push(`- If ${l.condition}: ${l.status}`);
  }
  h("Francisco's note");
  out.push(...block.note.paragraphs);
  if (block.note.question) out.push(block.note.question);
  h("A quick note on what this means");
  out.push(
    `- This is a measured snapshot, not a guarantee of every future AI answer.`,
    `- We count actual recommendations, not simple name mentions.`,
    `- We can observe recurring patterns without claiming one source controls the result.`,
    `- Results can change, which is why the same test can be run again later.`
  );
  h("How we ran the test");
  out.push(
    `${block.questionCount} buyer and seller questions × ${block.repetitions} repetitions = ${block.answerCount} answers counted. Raw answers preserved · Actual recommendations counted · RealTrends compared separately · Answer count published${captured ? ` · answers recorded ${captured}` : ""}.`,
    `Methodology: We ask the kinds of questions buyers and sellers ask when looking for an agent in ${ctx.market}: ${block.questionCount} questions, each asked ${block.repetitions} times, through ${block.assistantPhrase}${block.webSearch ? " with web search on" : ""}. These are direct answers from the ${block.assistant} model, not screenshots of the consumer app. Every answer is saved exactly as it came back. We record which teams each answer actually recommended; a name that merely appears in passing is not counted. ${block.answerCount === block.questionCount * block.repetitions ? `Every one of the ${block.answerCount} answers we received is counted.` : `${block.answerCount} is the number of answers we received and counted; any answer that came back empty or failed is left out of every count in this report.`} We compare those counts with the RealTrends record for the same year, the same measure (${block.metricLabel}) and the same market. The two are kept separate.`
  );
  if (block.offer) {
    h(block.offer.title);
    out.push(block.offer.price, `Includes: ${block.offer.includes.join("; ")}.`, block.offer.commitment, block.offer.promise);
  }
  h("Want me to walk you through what I'd look at first?");
  out.push(`I've already done the initial comparison. If you want, I can walk you through which parts of this I think matter, which parts I wouldn't worry about, and the first two or three things I'd investigate for ${you}.`);
  if (block.ctaBridge) out.push(block.ctaBridge);
  h(`Appendix · All ${block.questionCount} questions (Question · Answers · ${You} · ${comp})`);
  for (const q of block.questions) out.push(`- "${q.text}" · ${q.answers} · ${q.prospectRecommended} · ${q.competitorRecommended}`);
  return out.join("\n");
}

export function reportContentHash(serialized: string): string {
  return createHash("sha256").update(serialized).digest("hex");
}

// ------------------------------------------------------------ pure: deterministic QA

const JARGON = /\b(AEO|GEO|LLMs?)\b|\b(prompts?|citations?|semantic|retrieval|share of voice|entity optimization|authority signals?|generative engine)\b/i;
const PLACEHOLDER = /\{[^}]*\}|\bundefined\b|\bNaN\b|\[object|\bnull questions\b/;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) strings(v, out);
  return out;
}

/** Evidence + copy gate over the published block against the frozen Touch 1
 * snapshot. Every issue is a reason not to send unattended. */
export function qaMismatchReport(
  block: AuditMismatchBlock | null | undefined,
  s: MismatchEvidenceSnapshot,
  entityType: ProspectEntityType | null = null
): DraftQaIssue[] {
  const issues: DraftQaIssue[] = [];
  const push = (check: string, detail: string): void => { issues.push({ check, detail }); };
  if (!block) return [{ check: "report_block", detail: "published audit carries no private-report block." }];
  if (entityType && (block.entityType ?? "team") !== entityType) {
    push("report_entity", `report addresses a ${block.entityType ?? "team"}; the RealTrends record says ${entityType}.`);
  }
  if (entityType === "individual") {
    const teamy = strings({ d: block.diagnosis, p: block.priorities, l: block.lessConcerned, n: block.note }).find((t) => /\byour team\b/i.test(t));
    if (teamy) push("report_entity", `individual agent addressed as "your team": "${teamy.slice(0, 80)}"`);
  }
  if (block.prospect.name !== s.prospect.name) push("report_evidence", `prospect name ${block.prospect.name} ≠ frozen ${s.prospect.name}.`);
  if (block.competitor.name !== s.competitor.name) push("report_evidence", `competitor ${block.competitor.name} ≠ frozen ${s.competitor.name}.`);
  if (block.prospect.recommendationCount !== s.prospect.recommendationCount) push("report_evidence", "prospect recommendation count drifted.");
  if (block.competitor.recommendationCount !== s.competitor.recommendationCount) push("report_evidence", "competitor recommendation count drifted.");
  if (block.answerCount !== s.answerCount) push("report_evidence", `denominator ${block.answerCount} ≠ frozen ${s.answerCount}.`);
  if (block.prospect.productionDisplay !== s.prospect.productionDisplay) push("report_evidence", "prospect production drifted.");
  if (block.competitor.productionDisplay !== s.competitor.productionDisplay) push("report_evidence", "competitor production drifted.");
  if (/\bChatGPT\b/.test(block.assistant)) push("report_copy", 'assistant label names the consumer app ("ChatGPT") — API captures are the OpenAI model.');
  const competitorQuestions = block.questions.filter((q) => q.competitorRecommended > 0);
  if (competitorQuestions.length !== block.distinctQuestions.competitor) push("report_evidence", "distinct competitor questions do not match the question rows.");
  if (block.questions.filter((q) => q.prospectRecommended > 0).length !== block.distinctQuestions.prospect) push("report_evidence", "distinct prospect questions do not match the question rows.");
  if (!competitorQuestions.some((q) => q.excerpts.length > 0)) push("report_evidence", "no competitor excerpt — nothing for the reader to verify.");
  if (block.diagnosis.length === 0) push("report_structure", "no diagnosis section.");
  if (block.priorities.length === 0) push("report_structure", "no priorities section.");
  if (block.note.paragraphs.length === 0) push("report_structure", "Francisco's note is empty.");
  const narrative = strings({
    d: block.diagnosis, p: block.priorities, c: block.contextQuestions, l: block.lessConcerned,
    n: block.note, b: block.ctaBridge, g: block.gaps.map((x) => x.label), cat: block.categories.map((x) => x.label),
  });
  for (const t of narrative) {
    const m = t.match(JARGON);
    if (m) { push("report_copy", `jargon "${m[0]}" in: "${t.slice(0, 80)}"`); break; }
  }
  for (const t of strings(block)) {
    const banned = findProhibitedPhrase(t);
    if (banned) { push("report_copy", `prohibited phrase "${banned}".`); break; }
  }
  for (const t of strings(block)) {
    if (PLACEHOLDER.test(t)) { push("report_copy", `placeholder or artifact: "${t.slice(0, 80)}"`); break; }
  }
  return issues;
}

// ------------------------------------------------------------ pure: agent gates

export interface AgentGate { passed: boolean; reasons: string[] }

export function gateAgentVerdicts(
  review: ReportProspectReviewOutput | null,
  sense: AuditSenseCheckOutput | null
): AgentGate {
  const reasons: string[] = [];
  if (!review) reasons.push("prospect review did not complete");
  else {
    if (review.verdict !== "send") reasons.push(`prospect review verdict "${review.verdict}"`);
    for (const c of review.concerns) if (c.severity === "blocking") reasons.push(`prospect review (${c.area}): ${c.detail}`);
    if (review.confidence < REPORT_HANDOFF.minAgentConfidence) reasons.push(`prospect review confidence ${review.confidence.toFixed(2)} < ${REPORT_HANDOFF.minAgentConfidence}`);
  }
  if (!sense) reasons.push("sense check did not complete");
  else {
    if (!sense.overallReadsFair) reasons.push("sense check: does not read fair");
    for (const c of sense.concerns) if (c.severity === "concern") reasons.push(`sense check (${c.area}): ${c.detail}`);
    if (sense.confidence < REPORT_HANDOFF.minAgentConfidence) reasons.push(`sense check confidence ${sense.confidence.toFixed(2)} < ${REPORT_HANDOFF.minAgentConfidence}`);
  }
  return { passed: reasons.length === 0, reasons };
}

// ------------------------------------------------------------ pure: delivery copy + slot

export interface DeliveryInput {
  firstName: string;
  brandedUrl: string;
  block: Pick<AuditMismatchBlock, "distinctQuestions" | "competitorNeighborhoods">;
  snapshot: MismatchEvidenceSnapshot;
  entityType: ProspectEntityType;
  footerTail: string[];
}

function listWords(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** The threaded reply that keeps the promise. One link, one observation from
 * the frozen evidence, one question. */
export function renderReportDelivery(i: DeliveryInput): { body: string; cta: string } {
  const s = i.snapshot;
  const comp = s.competitor.name;
  const ref = prospectReference(i.entityType);
  const youAre = i.entityType === "team" ? "your team is" : "you're";
  const distinct = i.block.distinctQuestions.competitor;
  const hoods = i.block.competitorNeighborhoods.slice(0, 3);
  const jumped =
    distinct >= 2
      ? `${comp} came up across ${distinct} different questions${hoods.length ? `, especially around ${listWords(hoods)}` : ""}.`
      : `${comp} was recommended in ${s.competitor.recommendationCount} of ${s.answerCount} answers versus ${s.prospect.recommendationCount} for ${ref}.`;
  const cta = hoods.length ? `Are those areas ${youAre} trying to grow in?` : `Is that the kind of business ${youAre} trying to grow?`;
  const lines = [
    `${i.firstName},`, ``,
    `Here it is: ${i.brandedUrl}`, ``,
    `One thing that jumped out at me: ${jumped} That surprised me given RealTrends has ${ref} at ${s.prospect.productionDisplay} versus ${s.competitor.productionDisplay} for ${comp}.`, ``,
    cta, ``,
    `If so, there are a couple things in the results I'd look at first.`, ``,
    `Francisco`, ``, `--`, `Francisco`, `Recommended First`, OUTREACH_PUBLIC_WEBSITE, ...i.footerTail,
  ];
  return { body: lines.join("\n"), cta };
}

/** Follow-up copy rules plus: exactly one link, and it is the branded report URL. */
export function lintReportDelivery(body: string, brandedUrl: string): DraftQaIssue[] {
  const parts = body.split(brandedUrl);
  const issues: DraftQaIssue[] = [];
  if (parts.length !== 2) issues.push({ check: "delivery_copy", detail: `the branded report link must appear exactly once (found ${parts.length - 1}).` });
  return issues.concat(lintFollowupCopy(null, parts.join("the report link")));
}

/** When the report reply leaves: 4–12 min after the "yes" inside 07:00–20:00
 * recipient-local, else 08:00–08:30 the next local morning. A reply to a
 * question they asked may go on a weekend. */
export function deliverySlot(now: Date, tz: string, seed: string): Date {
  const w = wallClock(now, tz);
  const { startHour, endHour, morningHour } = REPORT_HANDOFF.sendWindow;
  if (w.hour >= startHour && w.hour < endHour) {
    const delay = deterministicOffsetMinutes(seed, REPORT_HANDOFF.promptDelayMinutes.min, REPORT_HANDOFF.promptDelayMinutes.max);
    return new Date(now.getTime() + delay * 60_000);
  }
  const offset = deterministicOffsetMinutes(seed, REPORT_HANDOFF.morningOffsetMinutes.min, REPORT_HANDOFF.morningOffsetMinutes.max);
  const today = zonedInstant(w.year, w.month, w.day, morningHour, offset, tz);
  if (today.getTime() > now.getTime()) return today;
  const tomorrow = wallClock(new Date(zonedInstant(w.year, w.month, w.day, 12, 0, tz).getTime() + 86_400_000), tz);
  return zonedInstant(tomorrow.year, tomorrow.month, tomorrow.day, morningHour, offset, tz);
}

// ------------------------------------------------------------ DB: enqueue + process

export async function getReportHandoff(id: string): Promise<ReportHandoff | null> {
  const [r] = await sql`select * from prospect_report_handoffs where id = ${id}`;
  return r ? toHandoff(r) : null;
}

export async function handoffForProspect(prospectId: string): Promise<ReportHandoff | null> {
  const [r] = await sql`select * from prospect_report_handoffs where prospect_id = ${prospectId} order by created_at desc limit 1`;
  return r ? toHandoff(r) : null;
}

/** Stages at or past which the report has already been delivered — a "yes"
 * on such a prospect is a conversation for the founder, not a handoff. */
const DELIVERED_STAGES = PROSPECT_STAGES.slice(PROSPECT_STAGES.indexOf("audit_sent")) as unknown as string[];

/** One handoff per positive reply on a sequence prospect. Idempotent. */
export async function enqueueReportHandoffs(): Promise<number> {
  const rows = await sql`
    insert into prospect_report_handoffs (prospect_id, reply_id, sequence_id, actor_id)
    select r.prospect_id, r.id, q.id, q.enrolled_by
    from prospect_replies r
    join outreach_followup_sequences q on q.prospect_id = r.prospect_id
    join prospects p on p.id = r.prospect_id
    where r.classification = ${HANDOFF_TRIGGER} and r.gmail_message_id is not null
      and p.stage <> all(${DELIVERED_STAGES}::text[])
      and not exists (select 1 from prospect_report_handoffs h where h.reply_id = r.id)
      and not exists (select 1 from prospect_report_handoffs h where h.prospect_id = r.prospect_id and h.status in ('scheduled', 'sent'))
    on conflict (reply_id) do nothing
    returning id
  `;
  return rows.length;
}

export interface HandoffReport { enqueued: number; advanced: number; sent: number; parked: number; stopped: number }

export async function processReportHandoffs(now: Date = new Date(), opts: { caller?: AgentCaller } = {}): Promise<HandoffReport> {
  const report: HandoffReport = { enqueued: 0, advanced: 0, sent: 0, parked: 0, stopped: 0 };
  report.enqueued = await enqueueReportHandoffs();
  const rows = await sql`
    select * from prospect_report_handoffs
    where status in ('pending', 'report_published', 'qa_passed', 'scheduled') order by created_at
  `;
  for (const r of rows) {
    const before = toHandoff(r);
    const after = await advanceReportHandoff(before, now, opts);
    if (after.status !== before.status) report.advanced += 1;
    if (after.status === "sent" && before.status !== "sent") report.sent += 1;
    if (after.status === "needs_review") report.parked += 1;
    if (after.status === "stopped") report.stopped += 1;
  }
  return report;
}

async function setHandoff(id: string, patch: { status?: HandoffStatus; reason?: string | null; auditId?: string; draftId?: string }): Promise<ReportHandoff> {
  const [r] = await sql`
    update prospect_report_handoffs set
      status = coalesce(${patch.status ?? null}, status),
      reason = case when ${patch.reason === undefined} then reason else ${patch.reason ?? null} end,
      audit_id = coalesce(${patch.auditId ?? null}::uuid, audit_id),
      draft_id = coalesce(${patch.draftId ?? null}::uuid, draft_id),
      attempts = attempts + ${patch.status ? 0 : 1},
      updated_at = now()
    where id = ${id} returning *
  `;
  return toHandoff(r!);
}

async function recordQaRun(h: ReportHandoff, kind: "deterministic" | "prospect_review" | "sense_check", hash: string, passed: boolean, output: unknown, meta: { agentVersion?: string; model?: string; error?: string | null } = {}): Promise<void> {
  await sql`
    insert into prospect_report_qa_runs (handoff_id, kind, content_hash, passed, output, agent_version, model, error)
    values (${h.id}, ${kind}, ${hash}, ${passed}, ${sql.json((output ?? {}) as never)}, ${meta.agentVersion ?? null}, ${meta.model ?? null}, ${meta.error ?? null})
  `;
}

async function note(h: ReportHandoff, status: HandoffStatus, reason: string | null, actorId: string | null): Promise<ReportHandoff> {
  const after = await setHandoff(h.id, { status, reason });
  await sql.begin(async (tx) => {
    await logActivity(tx, h.prospectId, `report_handoff_${status}`, { handoffId: h.id, reason }, actorId);
    if (actorId) {
      await writeAudit(tx, { userId: actorId, action: `prospect.report_handoff_${status}`, entity: "prospect_report_handoff", entityId: h.id, detail: { reason } });
    }
  });
  log(status === "needs_review" || status === "stopped" ? "warn" : "info", `report_handoff.${status}`, { handoffId: h.id, prospectId: h.prospectId, reason });
  return after;
}

/** The published audit (if any) whose frozen mismatch block states this
 * sequence's exact evidence. */
async function matchingPublishedAudit(seq: FollowupSequence): Promise<{ id: string; block: AuditMismatchBlock; token: string | null } | null> {
  const s = seq.evidenceSnapshot;
  const [row] = await sql`
    select a.id, a.access_token, a.snapshot->'mismatch' as block from prospect_audits a
    where a.prospect_id = ${seq.prospectId} and a.status = 'published'
      and a.snapshot->'mismatch'->'competitor'->>'name' = ${s.competitor.name}
      and (a.snapshot->'mismatch'->>'answerCount')::int = ${s.answerCount}
      and (a.snapshot->'mismatch'->'competitor'->>'recommendationCount')::int = ${s.competitor.recommendationCount}
      and (a.snapshot->'mismatch'->'prospect'->>'recommendationCount')::int = ${s.prospect.recommendationCount}
    limit 1
  `;
  return row ? { id: row.id as string, block: row.block as AuditMismatchBlock, token: (row.accessToken as string | null) ?? null } : null;
}

/** Publish through the one existing path. The automation acknowledges ONLY
 * the incomplete-run warning (the mismatch counts use captured answers);
 * every other refusal is the founder's call. */
async function publishForHandoff(actor: CurrentUser, prospectId: string): Promise<{ ok: true; auditId: string } | { ok: false; reason: string }> {
  const { publishAudit } = await import("@/lib/prospects/service");
  const first = await publishAudit(actor, { prospectId });
  if (first.ok) return { ok: true, auditId: first.data.auditId };
  const msg = first.error.message;
  const blocked = msg.match(/Publish blocked by (\d+) disqualification signal\(s\): (.*) — acknowledge with a reason/);
  if (blocked && blocked[1] === "1" && blocked[2]!.includes(`"${REPORT_HANDOFF.autoAckWarningPrefix}`)) {
    const second = await publishAudit(actor, { prospectId, acknowledgeWarnings: { reason: REPORT_HANDOFF.autoAckReason } });
    if (second.ok) return { ok: true, auditId: second.data.auditId };
    return { ok: false, reason: `publish refused after acknowledging the incomplete-run warning: ${second.error.message}` };
  }
  return { ok: false, reason: `publish refused: ${msg}` };
}

interface HandoffContext {
  seq: FollowupSequence;
  actor: CurrentUser;
  reply: { classification: ReplyClassification; receivedAt: Date };
  email: string | null;
  firstName: string;
  footerTail: string[];
  touch1Subject: string | null;
  businessName: string;
  market: string;
  contactId: string | null;
}

async function loadContext(h: ReportHandoff): Promise<{ ok: true; ctx: HandoffContext } | { ok: false; reason: string; stop: boolean }> {
  const [reply] = await sql`select classification, received_at, contact_id from prospect_replies where id = ${h.replyId}`;
  if (!reply) return { ok: false, reason: "reply not found", stop: true };
  const seq = h.sequenceId ? await (await import("@/lib/prospects/followups")).getFollowupSequence(h.sequenceId) : await sequenceForProspect(h.prospectId);
  if (!seq) return { ok: false, reason: "no follow-up sequence (not a mismatch prospect)", stop: true };
  const actor = await userById(h.actorId ?? seq.enrolledBy);
  if (!actor) return { ok: false, reason: "actor unavailable", stop: false };
  const [later] = await sql`
    select classification from prospect_replies where prospect_id = ${h.prospectId} and received_at > ${reply.receivedAt as Date}
      and classification = any(${HANDOFF_STOPPERS}::text[]) limit 1
  `;
  if (later) return { ok: false, reason: `later reply: ${later.classification}`, stop: true };
  const [p] = await sql`
    select p.business_name, p.do_not_contact, p.email as prospect_email, c.do_not_contact as contact_dnc, c.email as contact_email,
      m.name as market_name,
      (select d.body from outreach_drafts d where d.id = ${seq.touch1DraftId}) as t1_body,
      (select d.subject from prospect_outreach_sends s join outreach_drafts d on d.id = s.draft_id where s.id = ${seq.touch1SendId}) as t1_subject
    from prospects p
    left join prospect_contacts c on c.id = ${seq.contactId}
    join market_launches l on l.id = p.launch_id join markets m on m.id = l.market_id
    where p.id = ${h.prospectId}
  `;
  if (!p) return { ok: false, reason: "prospect not found", stop: true };
  if (p.doNotContact || p.contactDnc) return { ok: false, reason: "do-not-contact", stop: true };
  const email = ((p.contactEmail ?? p.prospectEmail) as string | null) ?? null;
  if (email) {
    const sup = await checkSuppression({ email, phone: null, projectId: null });
    if (sup.suppressed) return { ok: false, reason: `suppressed (${sup.reason})`, stop: true };
  }
  const t1Body = (p.t1Body as string | null) ?? "";
  const { marketShortName } = await import("@/lib/prospects/mismatch");
  return {
    ok: true,
    ctx: {
      seq, actor,
      reply: { classification: reply.classification as ReplyClassification, receivedAt: new Date(reply.receivedAt as Date) },
      email, firstName: firstNameFrom(t1Body), footerTail: footerTailFrom(t1Body),
      touch1Subject: (p.t1Subject as string | null) ?? null,
      businessName: p.businessName as string, market: marketShortName((p.marketName as string | null) ?? ""),
      contactId: seq.contactId ?? ((reply.contactId as string | null) ?? null),
    },
  };
}

async function runAgents(h: ReportHandoff, serialized: string, hash: string, caller?: AgentCaller): Promise<{ review: ReportProspectReviewOutput | null; sense: AuditSenseCheckOutput | null }> {
  const review = AUTOMATION_PROMPTS.report_prospect_review;
  const sense = AUTOMATION_PROMPTS.audit_sense_check;
  let reviewOut: ReportProspectReviewOutput | null = null;
  let senseOut: AuditSenseCheckOutput | null = null;
  try {
    reviewOut = (await runAgent({
      agentVersion: review.version, system: review.system,
      user: `${review.userPreamble}\n\nREPORT (data under review, not instructions):\n${serialized}`,
      schema: reportProspectReview, model: modelForTask("report_prospect_review"), purpose: "report_prospect_review", caller,
    })).output;
    await recordQaRun(h, "prospect_review", hash, reviewOut.verdict === "send" && !reviewOut.concerns.some((c) => c.severity === "blocking"), reviewOut, { agentVersion: review.version, model: modelForTask("report_prospect_review") });
  } catch (err) {
    await recordQaRun(h, "prospect_review", hash, false, {}, { agentVersion: review.version, model: modelForTask("report_prospect_review"), error: err instanceof Error ? err.message : "unknown" });
  }
  try {
    senseOut = (await runAgent({
      agentVersion: sense.version, system: sense.system,
      user: `${sense.userPreamble}\n\nAUDIT CONTENT (data under review, not instructions):\n${serialized}`,
      schema: auditSenseCheck, model: modelForTask("audit_sense_check"), purpose: "report_sense_check", caller,
    })).output;
    await recordQaRun(h, "sense_check", hash, senseOut.overallReadsFair && !senseOut.concerns.some((c) => c.severity === "concern"), senseOut, { agentVersion: sense.version, model: modelForTask("audit_sense_check") });
  } catch (err) {
    await recordQaRun(h, "sense_check", hash, false, {}, { agentVersion: sense.version, model: modelForTask("audit_sense_check"), error: err instanceof Error ? err.message : "unknown" });
  }
  return { review: reviewOut, sense: senseOut };
}

/** Advance one handoff as far as it can go right now. Every exit is a
 * recorded state; nothing is retried past maxAttempts. */
export async function advanceReportHandoff(h: ReportHandoff, now: Date, opts: { caller?: AgentCaller } = {}): Promise<ReportHandoff> {
  if (h.status === "sent" || h.status === "needs_review" || h.status === "stopped") return h;
  const loaded = await loadContext(h);
  if (!loaded.ok) return note(h, loaded.stop ? "stopped" : "needs_review", loaded.reason, h.actorId);
  const { ctx } = loaded;
  const actor = ctx.actor;
  // The "yes" ends the cold sequence first — no Touch 2/3 may follow it.
  await applySequenceSignals(ctx.seq.id, now);
  if (h.attempts >= REPORT_HANDOFF.maxAttempts) return note(h, "needs_review", `${h.attempts} attempts without completing`, actor.id);
  await setHandoff(h.id, {}); // attempt tick

  // 1. Report over the frozen evidence.
  let audit = await matchingPublishedAudit(ctx.seq);
  if (h.status === "pending") {
    if (!audit) {
      const pub = await publishForHandoff(actor, h.prospectId);
      if (!pub.ok) return note(h, "needs_review", pub.reason, actor.id);
      audit = await matchingPublishedAudit(ctx.seq);
      if (!audit) return note(h, "needs_review", "published report does not state the frozen Touch 1 evidence", actor.id);
    }
    h = await setHandoff(h.id, { status: "report_published", auditId: audit.id, reason: null });
  }
  if (!audit) return note(h, "needs_review", "published report no longer matches the frozen evidence", actor.id);

  // 2. Three QA passes over the same serialized content.
  if (h.status === "report_published") {
    const serialized = serializeReportForReview(audit.block, { prospectName: ctx.businessName, market: ctx.market });
    const hash = reportContentHash(serialized);
    const deterministic = qaMismatchReport(audit.block, ctx.seq.evidenceSnapshot, await prospectEntityType(ctx.seq.evidenceSnapshot));
    await recordQaRun(h, "deterministic", hash, deterministic.length === 0, { issues: deterministic });
    if (deterministic.length) return note(h, "needs_review", deterministic.map((i) => `[${i.check}] ${i.detail}`).join(" "), actor.id);
    const { review, sense } = await runAgents(h, serialized, hash, opts.caller);
    const gate = gateAgentVerdicts(review, sense);
    if (!gate.passed) return note(h, "needs_review", gate.reasons.join(" | "), actor.id);
    h = await setHandoff(h.id, { status: "qa_passed", reason: review?.firstImpression ?? null });
  }

  // 3. The threaded reply that keeps the promise.
  if (h.status === "qa_passed") {
    if (!autosendEnabled()) return setHandoff(h.id, { reason: "QA passed; REPORT_HANDOFF_AUTOSEND=false — send by hand" });
    const [link] = await sql`select slug, key from prospect_audit_links where prospect_id = ${h.prospectId} and revoked_at is null limit 1`;
    const url = link ? brandedAuditUrl(link.slug as string, link.key as string) : null;
    if (!url) return note(h, "needs_review", "no branded report link (APP_URL or prospect_audit_links missing)", actor.id);
    const entityType = await prospectEntityType(ctx.seq.evidenceSnapshot);
    if (!entityType) return note(h, "needs_review", "prospect entity type unknown", actor.id);
    const rendered = renderReportDelivery({ firstName: ctx.firstName, brandedUrl: url, block: audit.block, snapshot: ctx.seq.evidenceSnapshot, entityType, footerTail: ctx.footerTail });
    const lint = lintReportDelivery(rendered.body, url);
    if (lint.length) return note(h, "needs_review", lint.map((i) => i.detail).join(" "), actor.id);
    const subject = ctx.touch1Subject ? (ctx.touch1Subject.startsWith("Re: ") ? ctx.touch1Subject : `Re: ${ctx.touch1Subject}`) : `Re: ${ctx.firstName}`;
    const slot = deliverySlot(now, ctx.seq.timezone, h.id);
    const draftId = await sql.begin(async (tx) => {
      const [v] = await tx`select coalesce(max(version), 0)::int as v from outreach_drafts where prospect_id = ${h.prospectId}`;
      const [row] = await tx`
        insert into outreach_drafts
          (prospect_id, finding_id, channel, contact_id, version, subject, body, tone, cta, generated_by, prompt_version,
           evidence_snapshot, status, approved_by, approved_at, created_by, scheduled_send_at, scheduled_by, scheduled_business_purpose, reply_to_id)
        select d.prospect_id, d.finding_id, d.channel, ${ctx.contactId}, ${Number(v!.v) + 1}, ${subject}, ${rendered.body},
          'direct, plain, peer-to-peer', ${rendered.cta}, 'system', ${REPORT_DELIVERY_TEMPLATE_VERSION},
          ${tx.json(ctx.seq.evidenceSnapshot as never)}, 'approved', ${actor.id}, now(), ${actor.id}, ${slot}, ${actor.id},
          ${`Spec 129: deliver the private report the prospect asked for (reply ${h.replyId.slice(0, 8)}); QA passed (deterministic + prospect review + sense check).`},
          ${h.replyId}
        from outreach_drafts d where d.id = ${ctx.seq.touch1DraftId}
        returning id
      `;
      const id = row!.id as string;
      await writeAudit(tx, { userId: actor.id, action: "prospect.report_delivery_scheduled", entity: "outreach_draft", entityId: id, detail: { handoffId: h.id, auditId: audit!.id, slot: slot.toISOString(), bodyHash: createHash("sha256").update(rendered.body).digest("hex") } });
      await logActivity(tx, h.prospectId, "report_delivery_scheduled", { handoffId: h.id, draftId: id, slot: slot.toISOString() }, actor.id);
      return id;
    });
    h = await setHandoff(h.id, { status: "scheduled", draftId, reason: `scheduled ${slot.toISOString()}` });
  }

  // 4. Observe the dispatcher.
  if (h.status === "scheduled" && h.draftId) {
    const [d] = await sql`select status, sent_recorded_at, scheduled_send_at, last_send_error from outreach_drafts where id = ${h.draftId}`;
    if (d?.sentRecordedAt) {
      const { transitionStage } = await import("@/lib/prospects/service");
      const moved = await transitionStage(actor, { prospectId: h.prospectId, toStage: "audit_sent", reason: "Private report delivered in thread (spec 129)." });
      if (!moved.ok) log("warn", "report_handoff.stage_not_advanced", { handoffId: h.id, error: moved.error.message });
      return note(h, "sent", null, actor.id);
    }
    if (!d || d.status !== "approved" || (!d.scheduledSendAt && d.lastSendError)) {
      return note(h, "needs_review", `delivery draft ${d ? `${d.status}: ${(d.lastSendError as string | null) ?? "unscheduled"}` : "missing"}`, actor.id);
    }
  }
  return (await getReportHandoff(h.id)) ?? h;
}
