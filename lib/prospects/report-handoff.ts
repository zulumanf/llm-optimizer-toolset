/**
 * Positive-reply report handoff (spec 129) — now the autonomous, evidence-
 * locked fulfillment lane (spec 137). A "yes" to a competitive-mismatch
 * touch walks an explicit state machine: autonomy classification →
 * evidence release verification (spec 136: entities, production, frozen
 * run, primary = shadow counts, denominator, corrections) → the private
 * report over the SAME frozen evidence → ONE canonical fact manifest →
 * deterministic artifact assertions (report and email figures equal the
 * manifest) → ONE adversarial semantic review → release policy (SHADOW /
 * CANARY / NARROW_AUTONOMOUS / MANUAL_ONLY) → a durable send intent on the
 * existing outbox → send-time revalidation inside the one gated send path.
 * Any failed check parks the handoff for the founder with a deterministic
 * reason. Every verdict is an insert-only row bound to the hash it judged.
 */
import { createHash } from "node:crypto";
import { sql, type TransactionSql } from "@/db/client";
import { ClassifiedError } from "@/lib/errors";
import { writeAudit } from "@/db/audit";
import { log } from "@/lib/logger";
import type { CurrentUser } from "@/lib/auth";
import { runAgent, type AgentCaller } from "@/lib/ai/agent";
import { modelForTask } from "@/lib/ai/routing";
import { AUTOMATION_PROMPTS } from "@/lib/automation/prompts";
import {
  fulfillmentReleaseReview,
  type AuditSenseCheckOutput,
  type ReportProspectReviewOutput,
} from "@/lib/automation/nodes/agent";
import { getActiveSenderIdentity } from "@/lib/outreach/sender-identity";
import { compileFactManifest, evidenceHashOf, assertReportMatchesManifest, assertTextNumbersManifested, validatedSummarySentence, type CompiledSentence, type FactManifest } from "@/lib/prospects/fact-manifest";
import { evidenceSnapshotForDraft, releaseGateDetail, verifyEvidenceRelease, type EvidenceReleaseVerdict } from "@/lib/prospects/evidence-release";
import { assertTransition, releaseDecision, resolveLaneConfig, sendIntentKey, sendMessageIdFor, senderDomainOf, HANDOFF_STATUSES, type HandoffStatus } from "@/lib/prospects/fulfillment-lane";
import { classifyForAutonomy, type AutonomyClass } from "@/lib/prospects/reply-preprocess";
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
import { lintFollowupCopy, type ProspectEntityType } from "@/lib/prospects/followup-templates";
import type { AuditMismatchBlock } from "@/lib/prospects/audit-mismatch";
import type { DraftQaIssue } from "@/lib/prospects/draft-qa";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";
import { reportInvitationUrl } from "@/lib/prospects/urls";
import { logActivity } from "@/lib/prospects/shared";

export { HANDOFF_STATUSES };
export type { HandoffStatus };

/** Statuses in which a tick performs preparation work (and counts an attempt). */
const WORK_STATUSES: ReadonlySet<HandoffStatus> = new Set(["pending", "autonomy_eligible", "evidence_verified", "report_published", "qa_passed"]);
/** How often a held (SHADOW / canary-held / kill-switch) handoff re-validates its artifacts. */
const HELD_RECHECK_MINUTES = 30;

/** Replies that mean "send me the report" — the only trigger. */
export const HANDOFF_TRIGGER: ReplyClassification = "positive_interest";
/** A later reply of these kinds stops a handoff that has not sent. */
const HANDOFF_STOPPERS: ReplyClassification[] = ["unsubscribe", "not_interested", "decline"];

/** Legacy spec 129 opt-in; the lane mode (spec 137) supersedes it. */
export function autosendEnabled(): boolean {
  return resolveLaneConfig().mode === "NARROW_AUTONOMOUS";
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
  laneMode: string | null;
  autonomyClass: AutonomyClass | null;
  autonomyReason: string | null;
  autoVerdict: "would_send" | "transmit" | "escalated" | "held" | "blocked" | null;
  manifestId: string | null;
  updatedAt: Date;
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
    laneMode: (r.laneMode as string | null) ?? null,
    autonomyClass: (r.autonomyClass as AutonomyClass | null) ?? null,
    autonomyReason: (r.autonomyReason as string | null) ?? null,
    autoVerdict: (r.autoVerdict as ReportHandoff["autoVerdict"]) ?? null,
    manifestId: (r.manifestId as string | null) ?? null,
    updatedAt: new Date((r.updatedAt as Date | string) ?? Date.now()),
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
    `${You} closed more ${block.metricLabel.replace(/^closed /, "")}. ${comp} was recommended more.${notFluke ? ` ${comp} appeared across ${block.distinctQuestions.competitor} different questions.` : ""}`,
    `Difference: ${block.competitor.recommendationCount - block.prospect.recommendationCount} recommendations on the same ${block.answerCount} answers.`
  );
  if (block.changeFirst?.length) {
    h("What I'd change first");
    out.push(`Observed in the answers, the smallest change I'd make, and how the same test would show whether it moved. None of this is a ranking promise.`);
    for (const r of block.changeFirst) out.push(`- ${r.title} · Observed: ${r.observed} · Change: ${r.change} · Where: ${r.where} · Why first: ${r.whyFirst} · Test: ${r.test}`);
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
    out.push(block.offer.price, block.offer.total, `Includes: ${block.offer.includes.join("; ")}.`, block.offer.commitment, block.offer.promise);
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
  manifest: FactManifest;
  footerTail: string[];
}

/** The threaded reply that keeps the promise (spec 137 template v2): one
 * link, ONE compiled comparison sentence whose every figure is a manifest
 * display, no free-form rewriting anywhere. */
export function renderReportDelivery(i: DeliveryInput): { body: string; cta: string; summary: CompiledSentence } {
  const summary = validatedSummarySentence(i.manifest);
  const lines = [
    `${i.firstName},`, ``,
    `Absolutely. I put together the exact questions and side-by-side results here:`, ``,
    i.brandedUrl, ``,
    `The biggest thing that stood out: ${summary.text}`, ``,
    `I also included where that gap shows up and the first thing I'd look at changing.`, ``,
    `Take a look when you get a chance. If anything jumps out, just reply here.`, ``,
    `Francisco`, ``, `--`, `Francisco`, `Recommended First`, OUTREACH_PUBLIC_WEBSITE, ...i.footerTail,
  ];
  return { body: lines.join("\n"), cta: "read the private report", summary };
}

/** Follow-up copy rules plus: exactly one link, and it is the branded report URL. */
export function lintReportDelivery(body: string, brandedUrl: string): DraftQaIssue[] {
  const parts = body.split(brandedUrl);
  const issues: DraftQaIssue[] = [];
  if (parts.length !== 2) issues.push({ check: "delivery_copy", detail: `the branded report link must appear exactly once (found ${parts.length - 1}).` });
  return issues.concat(lintFollowupCopy(null, parts.join("the report link")));
}

/** Artifact assertion: every figure in the email body above the signature
 * (link removed) is a fact-manifest figure. A model that invents an extra
 * quantitative sentence fails here, deterministically. */
export function assertDeliveryMatchesManifest(body: string, brandedUrl: string, manifest: FactManifest): DraftQaIssue[] {
  const above = body.split("\n--\n")[0] ?? body;
  const text = above.split(brandedUrl).join(" ");
  return assertTextNumbersManifested(text, manifest).map((x) => ({ check: `manifest_${x.check}`, detail: x.detail }));
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

/** Approved evidence ids the manifest carries: the report's excerpted
 * answers (by response id) and its first priority. Deterministic over the
 * frozen block. */
export function approvedEvidenceFromBlock(block: AuditMismatchBlock): { exampleIds: string[]; firstActionId: string | null } {
  const ids = new Set<string>();
  for (const q of block.questions) for (const e of q.excerpts) ids.add(e.responseId);
  const first = block.priorities[0];
  const firstActionId = first ? `priority-1:${createHash("sha256").update(first.title).digest("hex").slice(0, 12)}` : null;
  return { exampleIds: [...ids].sort(), firstActionId };
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

/** One handoff per canonical positive reply. Idempotent: the reply id is
 * unique on the table, canonical replies collapse duplicates by
 * prospect+received_at, and a prospect with a live handoff gets no second
 * one. Any positive reply qualifies — Gmail-synced or hand-recorded, with
 * or without a follow-up sequence. A reply the founder already answered by
 * hand (an allowed send after it) is not re-handled. */
export async function enqueueReportHandoffs(): Promise<number> {
  const rows = await sql`
    insert into prospect_report_handoffs (prospect_id, reply_id, sequence_id, actor_id)
    select r.prospect_id, r.id, q.id, coalesce(q.enrolled_by, r.recorded_by)
    from (
      select distinct on (x.prospect_id, x.received_at) x.*
      from prospect_replies x order by x.prospect_id, x.received_at, x.created_at desc
    ) r
    left join outreach_followup_sequences q on q.prospect_id = r.prospect_id
    join prospects p on p.id = r.prospect_id
    where r.classification = ${HANDOFF_TRIGGER}
      and p.archived_at is null
      and p.stage <> all(${DELIVERED_STAGES}::text[])
      and not exists (select 1 from prospect_outreach_sends s where s.prospect_id = r.prospect_id and s.allowed and s.sent_at > r.received_at)
      and not exists (select 1 from prospect_report_handoffs h where h.reply_id = r.id)
      and not exists (select 1 from prospect_report_handoffs h where h.prospect_id = r.prospect_id and h.status not in ('needs_review', 'stopped'))
    on conflict (reply_id) do nothing
    returning id
  `;
  return rows.length;
}

export interface HandoffReport { enqueued: number; advanced: number; sent: number; parked: number; stopped: number; held: number }

export async function processReportHandoffs(now: Date = new Date(), opts: { caller?: AgentCaller } = {}): Promise<HandoffReport> {
  const report: HandoffReport = { enqueued: 0, advanced: 0, sent: 0, parked: 0, stopped: 0, held: 0 };
  report.enqueued = await enqueueReportHandoffs();
  const rows = await sql`
    select * from prospect_report_handoffs
    where status not in ('sent', 'needs_review', 'stopped') order by created_at
  `;
  for (const r of rows) {
    const before = toHandoff(r);
    const after = await advanceReportHandoff(before, now, opts);
    if (after.status !== before.status) report.advanced += 1;
    if (after.status === "sent" && before.status !== "sent") report.sent += 1;
    if (after.status === "needs_review") report.parked += 1;
    if (after.status === "stopped") report.stopped += 1;
    if (after.status === "release_ready" && after.autoVerdict === "would_send") report.held += 1;
  }
  return report;
}

interface HandoffPatch {
  reason?: string | null;
  auditId?: string;
  draftId?: string;
  manifestId?: string;
  laneMode?: string;
  autonomyClass?: AutonomyClass;
  autonomyReason?: string;
  autoVerdict?: ReportHandoff["autoVerdict"];
  releaseVerdict?: unknown;
}

/** The ONE state write. Every change names its expected current state
 * (optimistic: a concurrent worker's write makes this a no-row conflict)
 * and the transition table decides whether the move is legal. */
async function transition(h: ReportHandoff, to: HandoffStatus, patch: HandoffPatch = {}): Promise<ReportHandoff> {
  assertTransition(h.status, to);
  const [r] = await sql`
    update prospect_report_handoffs set
      status = ${to},
      reason = case when ${patch.reason === undefined} then reason else ${patch.reason ?? null} end,
      audit_id = coalesce(${patch.auditId ?? null}::uuid, audit_id),
      draft_id = coalesce(${patch.draftId ?? null}::uuid, draft_id),
      manifest_id = coalesce(${patch.manifestId ?? null}::uuid, manifest_id),
      lane_mode = coalesce(${patch.laneMode ?? null}, lane_mode),
      autonomy_class = coalesce(${patch.autonomyClass ?? null}, autonomy_class),
      autonomy_reason = coalesce(${patch.autonomyReason ?? null}, autonomy_reason),
      auto_verdict = coalesce(${patch.autoVerdict ?? null}, auto_verdict),
      release_verdict = coalesce(${patch.releaseVerdict === undefined ? null : sql.json(patch.releaseVerdict as never)}, release_verdict),
      updated_at = now()
    where id = ${h.id} and status = ${h.status} returning *
  `;
  if (!r) throw new ClassifiedError("conflict", `Handoff ${h.id} left ${h.status} under us; another worker owns it.`);
  return toHandoff(r);
}

async function tickAttempt(id: string, reason: string | null): Promise<void> {
  await sql`update prospect_report_handoffs set attempts = attempts + 1, reason = coalesce(${reason}, reason), updated_at = now() where id = ${id}`;
}

async function recordQaRun(h: ReportHandoff, kind: "deterministic" | "prospect_review" | "sense_check" | "release_gate" | "manifest_assertion" | "release_review", hash: string, passed: boolean, output: unknown, meta: { agentVersion?: string; model?: string; error?: string | null } = {}): Promise<void> {
  await sql`
    insert into prospect_report_qa_runs (handoff_id, kind, content_hash, passed, output, agent_version, model, error)
    values (${h.id}, ${kind}, ${hash}, ${passed}, ${sql.json((output ?? {}) as never)}, ${meta.agentVersion ?? null}, ${meta.model ?? null}, ${meta.error ?? null})
  `;
}

/** Park (needs_review) or stop, with the reason, activity and audit row. */
async function note(h: ReportHandoff, status: "needs_review" | "stopped", reason: string | null, actorId: string | null, patch: HandoffPatch = {}): Promise<ReportHandoff> {
  const after = await transition(h, status, { ...patch, reason, autoVerdict: patch.autoVerdict ?? (status === "stopped" ? "blocked" : /^ESCALATED/.test(reason ?? "") ? "escalated" : "blocked") });
  await sql.begin(async (tx) => {
    await logActivity(tx, h.prospectId, `report_handoff_${status}`, { handoffId: h.id, reason }, actorId);
    if (actorId) {
      await writeAudit(tx, { userId: actorId, action: `prospect.report_handoff_${status}`, entity: "prospect_report_handoff", entityId: h.id, detail: { reason } });
    }
  });
  log("warn", `report_handoff.${status}`, { handoffId: h.id, prospectId: h.prospectId, reason });
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
  reply: { classification: ReplyClassification; receivedAt: Date; bodyText: string };
  email: string | null;
  firstName: string;
  footerTail: string[];
  touch1Subject: string | null;
  businessName: string;
  market: string;
  contactId: string | null;
}

async function loadContext(h: ReportHandoff): Promise<{ ok: true; ctx: HandoffContext } | { ok: false; reason: string; stop: boolean }> {
  const [reply] = await sql`select classification, received_at, contact_id, body_text from prospect_replies where id = ${h.replyId}`;
  if (!reply) return { ok: false, reason: "reply not found", stop: true };
  const fu = await import("@/lib/prospects/followups");
  let seq: FollowupSequence | null = h.sequenceId ? await fu.getFollowupSequence(h.sequenceId) : await sequenceForProspect(h.prospectId);
  if (!seq) {
    // No enrolled sequence (a Touch 1 sent outside the cadence, or a hand
    // handled cohort): the delivered Touch 1 still carries the frozen
    // evidence. Build the same context from it; the sequence id stays null.
    const t1 = await fu.deliveredTouch1(h.prospectId).catch(() => null);
    if (!t1) return { ok: false, reason: "EVIDENCE_RELEASE_BLOCKED: no frozen mismatch evidence on file (no enrolled sequence, no delivered mismatch Touch 1) — founder answers this one by hand", stop: false };
    const { tz } = await fu.marketTimezone(h.prospectId);
    seq = {
      id: "", prospectId: h.prospectId, experimentId: "", contactId: t1.contactId,
      touch1DraftId: t1.draftId, touch1SendId: t1.sendId, touch1SentAt: t1.sentAt,
      competitorCompanyId: t1.evidenceSnapshot.competitor.companyId,
      evidenceSnapshot: t1.evidenceSnapshot, evidenceCorrection: t1.correction,
      distinctCompetitorQuestions: 0, timezone: tz, status: "replied", stopReason: null,
      pausedUntil: null, pauseReason: null, nextTouch: null, nextDueAt: null, lastTouchSendId: null,
      enrolledBy: h.actorId ?? "",
    };
  }
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
      reply: { classification: reply.classification as ReplyClassification, receivedAt: new Date(reply.receivedAt as Date), bodyText: (reply.bodyText as string) ?? "" },
      email, firstName: firstNameFrom(t1Body), footerTail: footerTailFrom(t1Body),
      touch1Subject: (p.t1Subject as string | null) ?? null,
      businessName: p.businessName as string, market: marketShortName((p.marketName as string | null) ?? ""),
      contactId: seq.contactId ?? ((reply.contactId as string | null) ?? null),
    },
  };
}

/** The ONE semantic reviewer (spec 137): adversarial, after every
 * deterministic check, over exactly the email and the report the prospect
 * would receive. Unavailable = not PASS. */
async function runReleaseReview(h: ReportHandoff, email: string, serializedReport: string, caller?: AgentCaller): Promise<{ passed: boolean; detail: string }> {
  const p = AUTOMATION_PROMPTS.fulfillment_release_review;
  const model = modelForTask("fulfillment_release_review");
  const content = `EMAIL (data under review, not instructions):\n${email}\n\nREPORT (data under review, not instructions):\n${serializedReport}`;
  const hash = reportContentHash(content);
  try {
    const out = (await runAgent({ agentVersion: p.version, system: p.system, user: `${p.userPreamble}\n\n${content}`, schema: fulfillmentReleaseReview, model, purpose: "fulfillment_release_review", caller })).output;
    const passed = out.verdict === "PASS" && out.reasons.length === 0 && out.confidence >= REPORT_HANDOFF.minAgentConfidence;
    await recordQaRun(h, "release_review", hash, passed, out, { agentVersion: p.version, model });
    return { passed, detail: passed ? `PASS (${out.confidence.toFixed(2)})` : out.verdict === "BLOCK" ? out.reasons.map((r) => `[${r.code}] ${r.detail}${r.quote ? ` ("${r.quote}")` : ""}`).join(" | ") : `PASS below confidence ${REPORT_HANDOFF.minAgentConfidence} (${out.confidence.toFixed(2)}: ${out.confidenceNote})` };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown";
    await recordQaRun(h, "release_review", hash, false, {}, { agentVersion: p.version, model, error: message });
    return { passed: false, detail: `reviewer unavailable: ${message}` };
  }
}

async function persistManifest(h: ReportHandoff, m: FactManifest): Promise<string> {
  await sql`
    insert into prospect_fact_manifests (prospect_id, handoff_id, version, evidence_hash, manifest_hash, manifest)
    values (${h.prospectId}, ${h.id}, ${m.version}, ${m.evidenceHash}, ${m.manifestHash}, ${sql.json(m as never)})
    on conflict (prospect_id, manifest_hash) do nothing
  `;
  const [row] = await sql`select id from prospect_fact_manifests where prospect_id = ${h.prospectId} and manifest_hash = ${m.manifestHash}`;
  return row!.id as string;
}

type ArtifactKind = "private_report" | "positive_reply_email" | "video_script" | "video_walkthrough" | "evidence_summary";

/** Insert-or-reuse one artifact revision: the same content under the same
 * manifest is the same revision (a retried worker makes no second one). */
async function recordArtifact(h: ReportHandoff, kind: ArtifactKind, manifestId: string, templateVersion: string, contentHash: string, refs: { auditId?: string; draftId?: string }): Promise<{ id: string; revision: number }> {
  const [same] = await sql`
    select id, revision from prospect_fulfillment_artifacts
    where handoff_id = ${h.id} and kind = ${kind} and manifest_id = ${manifestId} and content_hash = ${contentHash} and status <> 'stale'
    order by revision desc limit 1`;
  if (same) return { id: same.id as string, revision: Number(same.revision) };
  const [row] = await sql`
    insert into prospect_fulfillment_artifacts (handoff_id, prospect_id, kind, revision, manifest_id, template_version, ref_audit_id, ref_draft_id, content_hash, status)
    values (${h.id}, ${h.prospectId}, ${kind},
      (select coalesce(max(revision), 0) + 1 from prospect_fulfillment_artifacts where handoff_id = ${h.id} and kind = ${kind}),
      ${manifestId}, ${templateVersion}, ${refs.auditId ?? null}, ${refs.draftId ?? null}, ${contentHash}, 'ready')
    returning id, revision`;
  await sql`update prospect_fulfillment_artifacts set status = 'superseded', updated_at = now()
    where handoff_id = ${h.id} and kind = ${kind} and id <> ${row!.id} and status in ('prepared', 'ready')`;
  return { id: row!.id as string, revision: Number(row!.revision) };
}

async function markArtifactsStale(handoffId: string, reason: string): Promise<void> {
  await sql`update prospect_fulfillment_artifacts set status = 'stale', stale_reason = ${reason}, updated_at = now()
    where handoff_id = ${handoffId} and status in ('prepared', 'ready')`;
}

/** Fresh verdict + manifest for the frozen evidence. Read-only. */
async function verifyAndCompile(ctx: HandoffContext, approved: { exampleIds: string[]; firstActionId: string | null }): Promise<
  { ok: true; verdict: EvidenceReleaseVerdict; manifest: FactManifest } | { ok: false; verdict: EvidenceReleaseVerdict | null; reason: string }
> {
  const verdict = await verifyEvidenceRelease(ctx.seq.evidenceSnapshot, { prospectId: ctx.seq.prospectId, sendId: ctx.seq.touch1SendId });
  if (!verdict.verified) return { ok: false, verdict, reason: `EVIDENCE_RELEASE_BLOCKED: ${releaseGateDetail(verdict)}` };
  const entityType = await prospectEntityType(ctx.seq.evidenceSnapshot);
  const compiled = compileFactManifest({ snapshot: ctx.seq.evidenceSnapshot, verdict, market: ctx.market, prospectEntityType: entityType, approvedExampleIds: approved.exampleIds, approvedFirstActionId: approved.firstActionId });
  if (!compiled.ok) return { ok: false, verdict, reason: `EVIDENCE_RELEASE_BLOCKED: manifest not compilable: ${compiled.reason}` };
  return { ok: true, verdict, manifest: compiled.manifest };
}

/** Claim one handoff for this worker; a live claim by another worker (or a
 * young crashed one) yields null. Ten minutes bounds a crashed claim. */
async function claimHandoff(id: string): Promise<boolean> {
  const rows = await sql`
    update prospect_report_handoffs set claimed_at = now()
    where id = ${id} and (claimed_at is null or claimed_at < now() - interval '10 minutes') returning id`;
  return rows.length === 1;
}
async function releaseClaim(id: string): Promise<void> {
  await sql`update prospect_report_handoffs set claimed_at = null where id = ${id}`;
}

/** Advance one handoff as far as it can go right now. Every exit is a
 * recorded state; every state write is an explicit legal transition;
 * nothing is retried past maxAttempts. */
export async function advanceReportHandoff(h: ReportHandoff, now: Date, opts: { caller?: AgentCaller } = {}): Promise<ReportHandoff> {
  if (h.status === "sent" || h.status === "needs_review" || h.status === "stopped") return h;
  if (!(await claimHandoff(h.id))) return h;
  try {
    return await advanceClaimed(h, now, opts);
  } finally {
    await releaseClaim(h.id);
  }
}

async function advanceClaimed(h: ReportHandoff, now: Date, opts: { caller?: AgentCaller }): Promise<ReportHandoff> {
  const fresh = await getReportHandoff(h.id);
  if (!fresh || fresh.status !== h.status) return fresh ?? h;
  const loaded = await loadContext(h);
  if (!loaded.ok) return note(h, loaded.stop ? "stopped" : "needs_review", loaded.reason, h.actorId);
  const { ctx } = loaded;
  const actor = ctx.actor;
  const cfg = resolveLaneConfig();
  // The "yes" ends the cold sequence first — no Touch 2/3 may follow it.
  if (ctx.seq.id) await applySequenceSignals(ctx.seq.id, now);
  // Attempts count WORK (preparation) ticks only; a held or scheduled
  // handoff is observed, not retried, and never times out on its own.
  if (WORK_STATUSES.has(h.status)) {
    if (h.attempts >= REPORT_HANDOFF.maxAttempts) return note(h, "needs_review", `ARTIFACT_GENERATION_FAILED: ${h.attempts} attempts without completing`, actor.id);
    await tickAttempt(h.id, null);
  }

  // 0. POSITIVE_REPLY_RECEIVED → classify for autonomy.
  if (h.status === "pending") {
    const cls = classifyForAutonomy(ctx.reply.bodyText);
    const patch: HandoffPatch = { laneMode: cfg.mode, autonomyClass: cls.autonomyClass, autonomyReason: `${cls.reason} (${cls.version})` };
    if (cfg.mode === "MANUAL_ONLY") return note(h, "needs_review", "ESCALATED_TO_FOUNDER: lane MANUAL_ONLY", actor.id, { ...patch, autoVerdict: "escalated" });
    if (cls.autonomyClass === "escalate") return note(h, "needs_review", `ESCALATED_TO_FOUNDER: ${cls.reason}`, actor.id, { ...patch, autoVerdict: "escalated" });
    h = await transition(h, "autonomy_eligible", { ...patch, reason: null });
  }

  // 1. AUTONOMY_ELIGIBLE → EVIDENCE_VALIDATING → verified | blocked.
  if (h.status === "autonomy_eligible") {
    const v = await verifyAndCompile(ctx, { exampleIds: [], firstActionId: null });
    await recordQaRun(h, "release_gate", evidenceHashOf(ctx.seq.evidenceSnapshot), v.ok, v.verdict ?? { reason: v.ok ? null : v.reason });
    if (!v.ok) return note(h, "needs_review", v.reason, actor.id, { releaseVerdict: v.verdict });
    h = await transition(h, "evidence_verified", { releaseVerdict: v.verdict, reason: null });
  }

  // 2. EVIDENCE_VERIFIED → REPORT_READY over the same frozen evidence.
  let audit = await matchingPublishedAudit(ctx.seq);
  if (h.status === "evidence_verified") {
    if (!audit) {
      const pub = await publishForHandoff(actor, h.prospectId);
      if (!pub.ok) return note(h, "needs_review", `ARTIFACT_GENERATION_FAILED: ${pub.reason}`, actor.id);
      audit = await matchingPublishedAudit(ctx.seq);
      if (!audit) return note(h, "needs_review", "ARTIFACT_GENERATION_FAILED: published report does not state the frozen Touch 1 evidence", actor.id);
    }
    h = await transition(h, "report_published", { auditId: audit.id, reason: null });
  }
  if (!audit) return note(h, "needs_review", "RELEASE_BLOCKED: published report no longer matches the frozen evidence", actor.id);

  // 3. REPORT_READY → manifest → artifact assertions → ONE semantic review.
  if (h.status === "report_published") {
    const approved = approvedEvidenceFromBlock(audit.block);
    const v = await verifyAndCompile(ctx, approved);
    if (!v.ok) return note(h, "needs_review", v.reason, actor.id, { releaseVerdict: v.verdict });
    const manifestId = await persistManifest(h, v.manifest);
    const serialized = serializeReportForReview(audit.block, { prospectName: ctx.businessName, market: ctx.market });
    const reportHash = reportContentHash(serialized);
    const entityType = v.manifest.facts.FACT_PROSPECT_ENTITY_TYPE.value as ProspectEntityType;
    const deterministic = qaMismatchReport(audit.block, ctx.seq.evidenceSnapshot, entityType);
    const reportIssues = assertReportMatchesManifest(audit.block, v.manifest);
    await recordArtifact(h, "private_report", manifestId, audit.block.templateVersion, reportHash, { auditId: audit.id });
    await recordQaRun(h, "deterministic", reportHash, deterministic.length === 0, { issues: deterministic });
    if (deterministic.length) return note(h, "needs_review", `RELEASE_BLOCKED: ${deterministic.map((i) => `[${i.check}] ${i.detail}`).join(" ")}`, actor.id, { manifestId, releaseVerdict: v.verdict });
    // The invitation link (spec 134) — the credential leaves the address bar after one click.
    const [link] = await sql`
      select p.report_slug, l.key from prospect_audit_links l join prospects p on p.id = l.prospect_id
      where l.prospect_id = ${h.prospectId} and l.revoked_at is null and p.report_slug is not null limit 1`;
    const url = link ? reportInvitationUrl(link.reportSlug as string, link.key as string) : null;
    if (!url) return note(h, "needs_review", "RELEASE_BLOCKED: no private-report invitation (APP_URL, report_slug or prospect_audit_links missing)", actor.id, { manifestId, releaseVerdict: v.verdict });
    const rendered = renderReportDelivery({ firstName: ctx.firstName, brandedUrl: url, manifest: v.manifest, footerTail: ctx.footerTail });
    const emailIssues = [...lintReportDelivery(rendered.body, url), ...assertDeliveryMatchesManifest(rendered.body, url, v.manifest)];
    const bodyHash = createHash("sha256").update(rendered.body).digest("hex");
    await recordQaRun(h, "manifest_assertion", bodyHash, reportIssues.length === 0 && emailIssues.length === 0, { report: reportIssues, email: emailIssues, summaryFactIds: rendered.summary.factIds });
    if (reportIssues.length || emailIssues.length) {
      return note(h, "needs_review", `RELEASE_BLOCKED: ARTIFACT_ASSERTION_FAILED ${[...reportIssues, ...emailIssues].map((i) => `[${i.check}] ${i.detail}`).join(" ")}`, actor.id, { manifestId, releaseVerdict: v.verdict });
    }
    // The staged reply: approved, UNSCHEDULED, carrying its send intent. The
    // founder can send it by hand in any mode; the lane schedules it only
    // when the release policy says transmit.
    const subject = ctx.touch1Subject ? (ctx.touch1Subject.startsWith("Re: ") ? ctx.touch1Subject : `Re: ${ctx.touch1Subject}`) : `Re: ${ctx.firstName}`;
    const intentKey = sendIntentKey({ prospectId: h.prospectId, replyId: h.replyId, manifestHash: v.manifest.manifestHash, messageType: "positive_reply_report_delivery", templateVersion: REPORT_DELIVERY_TEMPLATE_VERSION });
    const sender = await getActiveSenderIdentity();
    const messageId = sendMessageIdFor(intentKey, senderDomainOf(sender?.replyToEmail));
    const draftId = await stageDeliveryDraft(h, ctx, actor, { subject, body: rendered.body, cta: rendered.cta, intentKey, messageId, auditId: audit.id });
    await recordArtifact(h, "positive_reply_email", manifestId, REPORT_DELIVERY_TEMPLATE_VERSION, bodyHash, { draftId, auditId: audit.id });
    const review = await runReleaseReview(h, rendered.body, serialized, opts.caller);
    if (!review.passed) return note(h, "needs_review", `RELEASE_BLOCKED: semantic review: ${review.detail}`, actor.id, { manifestId, draftId, releaseVerdict: v.verdict });
    h = await transition(h, "qa_passed", { manifestId, draftId, reason: review.detail, releaseVerdict: v.verdict });
  }

  // 4. SEMANTIC_QA passed → release policy.
  if (h.status === "qa_passed") {
    const decision = releaseDecision(cfg, h.id);
    if (decision.action === "manual_only") return note(h, "needs_review", `ESCALATED_TO_FOUNDER: ${decision.detail}`, actor.id, { laneMode: cfg.mode, autoVerdict: "escalated" });
    h = await transition(h, "release_ready", { laneMode: cfg.mode, autoVerdict: decision.autoVerdict, reason: decision.detail });
    await sql.begin(async (tx) => {
      await logActivity(tx, h.prospectId, "report_handoff_release_ready", { handoffId: h.id, mode: cfg.mode, autoVerdict: decision.autoVerdict, detail: decision.detail }, actor.id);
    });
  }

  // 5. RELEASE_READY: every tick re-validates the held or releasable
  // artifacts (a correction, recount or suppression since preparation parks
  // the handoff); only a transmit verdict creates the send intent schedule.
  if (h.status === "release_ready") {
    const draftId = h.draftId;
    if (!draftId) return h;
    const [handSent] = await sql`select sent_recorded_at from outreach_drafts where id = ${draftId}`;
    if (handSent?.sentRecordedAt) h = await transition(h, "scheduled", { reason: "sent outside the lane's schedule (founder / dispatcher); following the ledger" });
  }
  if (h.status === "release_ready") {
    // A held handoff re-validates at most every HELD_RECHECK_MINUTES (the
    // shadow recount is not free); a transmit verdict always re-validates.
    if (h.autoVerdict !== "transmit" && now.getTime() - h.updatedAt.getTime() < HELD_RECHECK_MINUTES * 60_000) return h;
    const recheck = await fulfillmentSendRecheck(sql, h.draftId);
    if (!recheck.passed) return note(h, "needs_review", `RELEASE_BLOCKED: ${recheck.detail}`, actor.id);
    if (h.autoVerdict !== "transmit") {
      await sql`update prospect_report_handoffs set updated_at = now() where id = ${h.id}`;
      return h;
    }
    const slot = deliverySlot(now, ctx.seq.timezone, h.id);
    const rows = await sql`
      update outreach_drafts set scheduled_send_at = ${slot}, scheduled_by = ${actor.id}
      where id = ${h.draftId} and status = 'approved' and sent_recorded_at is null and scheduled_send_at is null returning id`;
    if (rows.length === 0) {
      const [d] = await sql`select scheduled_send_at, sent_recorded_at from outreach_drafts where id = ${h.draftId}`;
      if (!d?.scheduledSendAt && !d?.sentRecordedAt) return note(h, "needs_review", "RELEASE_BLOCKED: delivery draft is no longer schedulable", actor.id);
    }
    await sql.begin(async (tx) => {
      await writeAudit(tx, { userId: actor.id, action: "prospect.report_delivery_scheduled", entity: "outreach_draft", entityId: h.draftId!, detail: { handoffId: h.id, slot: slot.toISOString(), mode: cfg.mode } });
      await logActivity(tx, h.prospectId, "report_delivery_scheduled", { handoffId: h.id, draftId: h.draftId, slot: slot.toISOString() }, actor.id);
    });
    h = await transition(h, "scheduled", { reason: `scheduled ${slot.toISOString()}` });
  }

  // 6. Observe the dispatcher (the one gated send path re-verifies everything).
  if (h.status === "scheduled" && h.draftId) {
    const [d] = await sql`select status, sent_recorded_at, scheduled_send_at, last_send_error from outreach_drafts where id = ${h.draftId}`;
    if (d?.sentRecordedAt) {
      const { transitionStage } = await import("@/lib/prospects/service");
      const moved = await transitionStage(actor, { prospectId: h.prospectId, toStage: "audit_sent", reason: "Private report delivered in thread (spec 129/137)." });
      if (!moved.ok) log("warn", "report_handoff.stage_not_advanced", { handoffId: h.id, error: moved.error.message });
      await sql`update prospect_fulfillment_artifacts set status = 'sent', updated_at = now() where handoff_id = ${h.id} and status = 'ready'`;
      h = await transition(h, "sent", { reason: null });
      await sql.begin(async (tx) => { await logActivity(tx, h.prospectId, "report_handoff_sent", { handoffId: h.id }, actor.id); });
      return h;
    }
    if (!d || d.status !== "approved" || (!d.scheduledSendAt && d.lastSendError)) {
      return note(h, "needs_review", `RELEASE_BLOCKED: delivery draft ${d ? `${d.status}: ${(d.lastSendError as string | null) ?? "unscheduled"}` : "missing"}`, actor.id);
    }
  }
  return (await getReportHandoff(h.id)) ?? h;
}

/** Insert the staged delivery draft once per send intent. A retried worker
 * or a second worker finds the existing row by the unique intent key. */
async function stageDeliveryDraft(
  h: ReportHandoff, ctx: HandoffContext, actor: CurrentUser,
  d: { subject: string; body: string; cta: string; intentKey: string; messageId: string; auditId: string }
): Promise<string> {
  const [existing] = await sql`select id from outreach_drafts where send_intent_key = ${d.intentKey}`;
  if (existing) {
    await sql.begin(async (tx) => {
      await writeAudit(tx, { userId: actor.id, action: "prospect.fulfillment_duplicate_prevented", entity: "outreach_draft", entityId: existing.id as string, detail: { handoffId: h.id, intentKey: d.intentKey } });
    });
    return existing.id as string;
  }
  return sql.begin(async (tx) => {
    const [v] = await tx`select coalesce(max(version), 0)::int as v from outreach_drafts where prospect_id = ${h.prospectId}`;
    const rows = await tx`
      insert into outreach_drafts
        (prospect_id, finding_id, channel, contact_id, version, subject, body, tone, cta, generated_by, prompt_version,
         evidence_snapshot, status, approved_by, approved_at, created_by, scheduled_business_purpose, reply_to_id, send_intent_key, send_message_id)
      select x.prospect_id, x.finding_id, x.channel, ${ctx.contactId}, ${Number(v!.v) + 1}, ${d.subject}, ${d.body},
        'direct, plain, peer-to-peer', ${d.cta}, 'system', ${REPORT_DELIVERY_TEMPLATE_VERSION},
        ${tx.json(ctx.seq.evidenceSnapshot as never)}, 'approved', ${actor.id}, now(), ${actor.id},
        ${`Spec 137: deliver the private report the prospect asked for (reply ${h.replyId.slice(0, 8)}); evidence verified, manifest asserted, semantic review pending/passed.`},
        ${h.replyId}, ${d.intentKey}, ${d.messageId}
      from outreach_drafts x where x.id = ${ctx.seq.touch1DraftId}
      on conflict (send_intent_key) where send_intent_key is not null do nothing
      returning id
    `;
    const id = rows[0]?.id as string | undefined;
    if (!id) {
      const [again] = await tx`select id from outreach_drafts where send_intent_key = ${d.intentKey}`;
      return again!.id as string;
    }
    await writeAudit(tx, { userId: actor.id, action: "prospect.report_delivery_staged", entity: "outreach_draft", entityId: id, detail: { handoffId: h.id, auditId: d.auditId, intentKey: d.intentKey, bodyHash: createHash("sha256").update(d.body).digest("hex") } });
    await logActivity(tx, h.prospectId, "report_delivery_staged", { handoffId: h.id, draftId: id }, actor.id);
    return id;
  });
}

/**
 * Send-time revalidation (spec 137) for a draft that carries a send intent:
 * the handoff must still be releasable, and the fact manifest recompiled
 * from a FRESH release verdict over the frozen evidence must hash to the
 * manifest the artifacts were compiled from. A correction, a recount, an
 * entity change or a denominator change between preparation and send
 * changes the hash: the artifacts are marked stale and the send refuses.
 * Runs inside the send gate (any channel, human or dispatcher).
 */
export async function fulfillmentSendRecheck(db: TransactionSql | typeof sql, draftId: string): Promise<{ passed: boolean; detail: string }> {
  // jsonb is read as text: the client's camelCase transform would mangle
  // FACT_* keys (postgres.camel also rewrites JSON object keys).
  const [h] = await db`select h.*, m.manifest::text as manifest_text, m.manifest_hash from prospect_report_handoffs h
    left join prospect_fact_manifests m on m.id = h.manifest_id where h.draft_id = ${draftId} order by h.created_at desc limit 1`;
  if (!h) return { passed: true, detail: "no fulfillment handoff behind this draft" };
  if (!["release_ready", "scheduled"].includes(h.status as string)) return { passed: false, detail: `handoff is ${h.status}; only release_ready/scheduled may transmit` };
  if (!h.manifestText) return { passed: false, detail: "handoff has no fact manifest" };
  const found = await evidenceSnapshotForDraft(db, draftId);
  if (!found) return { passed: false, detail: "delivery draft carries no frozen evidence" };
  const stored = JSON.parse(h.manifestText as string) as FactManifest;
  const [seqRow] = h.sequenceId ? await db`select touch1_send_id from outreach_followup_sequences where id = ${h.sequenceId}` : [];
  const t1 = seqRow ? ((seqRow.touch1SendId as string | null) ?? null) : await (async () => {
    const fu = await import("@/lib/prospects/followups");
    return (await fu.deliveredTouch1(h.prospectId as string).catch(() => null))?.sendId ?? null;
  })();
  const verdict = await verifyEvidenceRelease(found.snapshot, { prospectId: h.prospectId as string, sendId: t1 });
  const entityType = await prospectEntityType(found.snapshot);
  const compiled = compileFactManifest({
    snapshot: found.snapshot, verdict, market: stored.facts.FACT_MARKET.value as string, prospectEntityType: entityType,
    approvedExampleIds: stored.facts.FACT_APPROVED_EXAMPLE_IDS.value as string[], approvedFirstActionId: stored.facts.FACT_APPROVED_FIRST_ACTION_ID.value as string | null,
  });
  const reason = !compiled.ok ? `manifest no longer compiles: ${compiled.reason}` : compiled.manifest.manifestHash !== (h.manifestHash as string) ? `fact manifest changed since preparation (${(h.manifestHash as string).slice(0, 12)} → ${compiled.manifest.manifestHash.slice(0, 12)})` : null;
  if (reason) {
    await markArtifactsStale(h.id as string, reason);
    return { passed: false, detail: `SEND_TIME_REVALIDATION_FAILED: ${reason}` };
  }
  return { passed: true, detail: `fact manifest ${(h.manifestHash as string).slice(0, 12)} re-verified at send time` };
}
