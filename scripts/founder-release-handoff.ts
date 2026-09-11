/**
 * Founder one-off release (spec 138/139). Prints every release gate for ONE
 * handoff and, only with --send and only when every gate passes, transmits
 * the staged video-variant draft through the ONE gated send path
 * (`sendProspectDraft`: every gate re-runs at transmission, the send intent
 * makes it effectively-once). The global lane mode is never touched.
 *
 *   npx tsx scripts/founder-release-handoff.ts --handoff <id> [--as <email>] [--send --purpose "…"]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const handoffId = arg("--handoff");
  if (!handoffId) throw new Error("usage: --handoff <id> [--as <email>] [--send --purpose <text>]");
  const send = process.argv.includes("--send");
  const rh = await import("@/lib/prospects/report-handoff");
  const vw = await import("@/lib/prospects/video-walkthrough");
  const lane = await import("@/lib/prospects/fulfillment-lane");
  const { checkSuppression } = await import("@/lib/outreach/suppression");
  const h = await rh.getReportHandoff(handoffId);
  if (!h) throw new Error("handoff not found");
  const [p] = await sql`select p.business_name, p.do_not_contact, p.email as prospect_email, c.email as contact_email, r.gmail_message_id, r.gmail_thread_id
    from prospect_report_handoffs x join prospects p on p.id = x.prospect_id join prospect_replies r on r.id = x.reply_id
    left join prospect_contacts c on c.id = r.contact_id where x.id = ${handoffId}`;
  const cfg = lane.resolveLaneConfig();
  const video = await vw.videoForHandoff(handoffId);
  const videoCheck = await vw.videoReleaseRecheck(handoffId, process.env, { handoffStatuses: ["qa_passed", "release_ready", "scheduled"] });
  const [draft] = h.draftId ? await sql`select id, status, subject, body, send_intent_key, scheduled_send_at, sent_recorded_at, reply_to_id from outreach_drafts where id = ${h.draftId}` : [];
  const [priorSends] = await sql`select count(*)::int as n from prospect_outreach_sends s join outreach_drafts d on d.id = s.draft_id where d.prospect_id = ${h.prospectId} and s.allowed and d.reply_to_id is not null`;
  const email = ((p?.contactEmail ?? p?.prospectEmail) as string | null) ?? null;
  const sup = email ? await checkSuppression({ email, phone: null, projectId: null }) : { suppressed: false, reason: null };
  const qa = await sql`select kind, bool_or(passed) as passed from prospect_report_qa_runs where handoff_id = ${handoffId} group by kind order by kind`;
  const qaMap = Object.fromEntries(qa.map((q) => [q.kind as string, Boolean(q.passed)]));
  const recheck = h.draftId ? await rh.fulfillmentSendRecheck(sql, h.draftId) : { passed: false, detail: "no draft" };
  const videoVariant = draft?.body ? /quick walkthrough/.test(draft.body as string) : false;
  const gates: [string, boolean, string][] = [
    ["EVIDENCE_RELEASE_VERIFIED", qaMap.release_gate === true, String(qaMap.release_gate)],
    ["REPORT_FACTS_MATCH_MANIFEST + EMAIL_FACTS_MATCH_MANIFEST", qaMap.manifest_assertion === true, String(qaMap.manifest_assertion)],
    ["REPORT_DETERMINISTIC_QA", qaMap.deterministic === true, String(qaMap.deterministic)],
    ["REPORT_SEMANTIC_QA", qaMap.release_review === true, String(qaMap.release_review)],
    ["VIDEO_SCRIPT_QA", qaMap.video_script_qa === true, String(qaMap.video_script_qa)],
    ["VIDEO_SEMANTIC_QA", qaMap.video_semantic_review === true, String(qaMap.video_semantic_review)],
    ["VIDEO_ARTIFACT_QA", qaMap.video_artifact_qa === true, String(qaMap.video_artifact_qa)],
    ["VIDEO_RELEASE_READY", videoCheck.passed, videoCheck.detail],
    ["SAME_MANIFEST_REPORT_VIDEO", Boolean(video && h.manifestId && video.manifestId === h.manifestId), `${video?.manifestId?.slice(0, 8) ?? "none"} vs ${h.manifestId?.slice(0, 8) ?? "none"}`],
    ["NO_PENDING_CORRECTION + MANIFEST_CURRENT (send recheck)", recheck.passed, recheck.detail],
    ["NO_SUPPRESSION", !sup.suppressed && !p?.doNotContact, sup.reason ?? "clear"],
    ["EMAIL_IS_VIDEO_VARIANT", videoVariant, draft ? `draft ${(draft.id as string).slice(0, 8)} ${draft.status as string}` : "no draft"],
    ["EMAIL_THREADED_REPLY", Boolean(draft?.replyToId && p?.gmailThreadId), `thread ${(p?.gmailThreadId as string | null) ?? "none"}`],
    ["SEND_NOT_ALREADY_EXECUTED", !draft?.sentRecordedAt && Number(priorSends?.n ?? 0) === 0, `prior threaded sends: ${priorSends?.n ?? 0}`],
    ["HANDOFF_RELEASABLE", h.status === "release_ready", `${h.status} (${h.autoVerdict ?? "-"})`],
    ["RELEASE_POLICY", cfg.releasePolicy === "report_and_video", `${cfg.releasePolicy} / mode ${cfg.mode}`],
  ];
  for (const [name, ok, detail] of gates) console.log(`${ok ? "PASS " : "BLOCK"} ${name}: ${detail}`);
  console.log(`recipient=${email ?? "?"} business=${p?.businessName as string} subject=${(draft?.subject as string | undefined) ?? "?"} manifest=${h.manifestId?.slice(0, 8)} report=${h.auditId?.slice(0, 8)} video=${video?.id.slice(0, 8) ?? "none"} (${video?.stage ?? "-"})`);
  const allPass = gates.every((g) => g[1]);
  if (!send) { console.log(allPass ? "ALL GATES PASS — rerun with --send --purpose to transmit" : "NOT RELEASABLE"); process.exit(allPass ? 0 : 1); }
  if (!allPass) { console.error("refusing to send: a gate is blocking"); process.exit(1); }
  const purpose = arg("--purpose");
  if (!purpose || purpose.length < 10) throw new Error("--purpose is required (≥ 10 chars)");
  const asEmail = arg("--as");
  const [u] = asEmail ? await sql`select id, email, name, role from users where email = ${asEmail}` : await sql`select id, email, name, role from users where role = 'admin' order by created_at limit 1`;
  if (!u) throw new Error("no releasing user");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
  const svc = await import("@/lib/prospects/service");
  await sql.begin(async (tx) => {
    await writeAudit(tx, { userId: user.id, action: "prospect.founder_one_off_release", entity: "prospect_report_handoff", entityId: handoffId, detail: { draftId: h.draftId, manifestId: h.manifestId, auditId: h.auditId, videoArtifactId: video?.id ?? null, videoContentHash: video?.contentHash ?? null, laneMode: cfg.mode, releasePolicy: cfg.releasePolicy, purpose } });
  });
  const r = await svc.sendProspectDraft(user, { draftId: h.draftId!, channel: "gmail", businessPurpose: purpose });
  if (!r.ok) { console.error(`send refused: ${r.error.message}`); process.exit(2); }
  console.log(`SENT sendId=${r.data.sendId} providerMessageId=${r.data.providerMessageId ?? "?"}`);
  await rh.processReportHandoffs(new Date());
  const after = await rh.getReportHandoff(handoffId);
  console.log(`handoff now ${after?.status} (${after?.reason ?? ""})`);
  await sql.end();
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
