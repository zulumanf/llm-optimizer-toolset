/**
 * Operating review follow-through (2026-09-07). Read-only by default; every
 * mutation needs --apply and is one of the review's own decisions:
 *
 *   npx tsx scripts/next-client-ops.ts gate-check            # entity gate over every queued count email
 *   npx tsx scripts/next-client-ops.ts sales-block --prospect <uuid|name>
 *   npx tsx scripts/next-client-ops.ts waiting               # positive replies waiting on us (Today's list)
 *   npx tsx scripts/next-client-ops.ts backfill-owners [--apply]
 *   npx tsx scripts/next-client-ops.ts resolve --prospect <uuid|name> --outcome "..." [--apply]
 *   npx tsx scripts/next-client-ops.ts contact-queue [--limit 50]
 *   npx tsx scripts/next-client-ops.ts hygiene [--apply]     # archive QA131 fixtures, disable dead trigger, retire stale failed proposals
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { countClaimEntityGate } from "@/lib/prospects/entity-aliases";
import { contactSupplyQueue, retireStaleFailedProposals } from "@/lib/prospects/enrichment";
import { ensurePositiveReplyOwnership, founderUserId, positiveRepliesWaiting, resolvePositiveReply } from "@/lib/prospects/positive-replies";
import { renderFounderSalesBlock, salesBlockForProspect } from "@/lib/prospects/sales-block";

const APPLY = process.argv.includes("--apply");
const arg = (k: string): string | null => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1]! : null; };
const cmd = process.argv[2] ?? "help";

async function founder(): Promise<CurrentUser> {
  const id = await founderUserId();
  const [u] = await sql`select id, email, name, role from users where id = ${id}`;
  if (!u) throw new Error("founder user not found");
  return { id: u.id, email: u.email, name: u.name, role: u.role } as CurrentUser;
}
async function prospectId(ref: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(ref)) return ref;
  const [p] = await sql`select id from prospects where business_name = ${ref} and archived_at is null`;
  if (!p) throw new Error(`prospect not found: ${ref}`);
  return p.id as string;
}

async function gateCheck(): Promise<void> {
  const rows = await sql`
    with recursive q as (
      select d.id as draft_id, d.prospect_id, d.scheduled_send_at, d.touch_number, d.prompt_version, d.id as node, d.parent_id, d.evidence_snapshot, 0 as depth
      from outreach_drafts d where d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at is not null
      union all
      select q.draft_id, q.prospect_id, q.scheduled_send_at, q.touch_number, q.prompt_version, p.id, p.parent_id, p.evidence_snapshot, q.depth + 1
      from q join outreach_drafts p on p.id = q.parent_id where q.evidence_snapshot is null and q.depth < 10
    )
    select distinct on (draft_id) draft_id, prospect_id, scheduled_send_at, touch_number, prompt_version, evidence_snapshot,
      (select business_name from prospects where id = q.prospect_id) as business_name
    from q order by draft_id, depth asc`;
  const tally: Record<string, number> = {};
  for (const r of rows) {
    const snap = r.evidenceSnapshot as { prospect: { companyId: string; prospectId: string | null; name: string }; competitor: { companyId: string; prospectId: string | null; name: string } } | null;
    let verdict = "no count claim";
    if (snap?.prospect?.companyId && snap.competitor?.companyId) {
      const g = await countClaimEntityGate(snap);
      verdict = g.passed ? "VERIFIED" : g.detail;
    }
    const key = verdict === "VERIFIED" ? "VERIFIED" : verdict === "no count claim" ? "NO_CLAIM" : "UNVERIFIED";
    tally[key] = (tally[key] ?? 0) + 1;
    console.log(`${(r.scheduledSendAt as Date).toISOString().slice(0, 16)} T${r.touchNumber ?? 1} ${r.businessName}: ${verdict.slice(0, 220)}`);
  }
  console.log("\nTALLY", JSON.stringify(tally));
}

async function main(): Promise<void> {
  if (cmd === "gate-check") await gateCheck();
  else if (cmd === "sales-block") {
    const id = await prospectId(arg("--prospect")!);
    const b = await salesBlockForProspect(id);
    console.log(b ? renderFounderSalesBlock(b) + `\n\n(source: audit ${b.source.auditId}, published ${b.source.publishedAt?.toISOString() ?? "?"})` : "No evidence-backed change-first row on the latest published report; nothing to show.");
  } else if (cmd === "waiting") {
    for (const w of await positiveRepliesWaiting()) console.log(JSON.stringify({ ...w, excerpt: w.excerpt.slice(0, 80) }));
  } else if (cmd === "backfill-owners") {
    const before = await positiveRepliesWaiting();
    console.log(`waiting: ${before.length}; without owner/next action/due: ${before.filter((w) => !w.ownerName || !w.nextAction || !w.nextActionOn).length}`);
    if (APPLY) { const f = await founder(); console.log(`stamped ${await ensurePositiveReplyOwnership(f.id)}`); for (const w of await positiveRepliesWaiting()) console.log(`${w.businessName}: owner ${w.ownerName} · ${w.nextActionOn} · ${w.nextAction}`); }
  } else if (cmd === "resolve") {
    const id = await prospectId(arg("--prospect")!);
    const w = (await positiveRepliesWaiting()).filter((x) => x.prospectId === id);
    console.log(`open positive replies for prospect: ${w.length}`);
    if (APPLY) { const f = await founder(); for (const x of w) console.log(JSON.stringify(await resolvePositiveReply(f, { prospectId: id, replyId: x.replyId, outcome: arg("--outcome") ?? "resolved" }))); }
  } else if (cmd === "contact-queue") {
    const [c] = await sql`
      with live as (select p.* from prospects p where p.archived_at is null and not p.do_not_contact and p.business_name not like 'QA131%' and p.stage = 'identified')
      select count(*)::int as live_identified,
        count(*) filter (where exists (select 1 from prospect_contacts c where c.prospect_id = live.id and c.archived_at is null and c.email is not null and not c.do_not_contact and c.provenance in ('publicly_sourced','manual')))::int as with_verified,
        count(*) filter (where exists (select 1 from prospect_contacts c where c.prospect_id = live.id and c.archived_at is null and c.email is not null and not c.do_not_contact and c.provenance = 'ai_inferred')
          and not exists (select 1 from prospect_contacts c where c.prospect_id = live.id and c.archived_at is null and c.email is not null and not c.do_not_contact and c.provenance in ('publicly_sourced','manual')))::int as ai_inferred_only
      from live`;
    console.log(`LIVE IDENTIFIED ${c!.liveIdentified} · WITH VERIFIED CONTACT ${c!.withVerified} · WITHOUT ${Number(c!.liveIdentified) - Number(c!.withVerified)} (of which AI-inferred only ${c!.aiInferredOnly})`);
    const q = await contactSupplyQueue(Number(arg("--limit") ?? 40));
    console.log("PROSPECT | PRIORITY | CONTACT_STATUS | SOURCE | VERIFICATION | NEXT_ACTION");
    for (const r of q) console.log(`${r.businessName} (${r.market ?? "?"}) | ${r.priority} | ${r.contactStatus} | ${r.source ?? "-"} | ${r.verificationStatus} | ${r.nextAction}`);
    console.log(`\nqueue rows shown ${q.length}`);
  } else if (cmd === "hygiene") {
    const fixtures = await sql`select id, business_name from prospects where business_name like 'QA131%' and archived_at is null`;
    const [trig] = await sql`select id, name, enabled from automation_triggers where key = 'daily_control_tower_v1' or name = 'Every morning before the working day'`;
    const [stale] = await sql`select count(*)::int as n from enrichment_proposals where status = 'failed' and created_at < now() - interval '7 days'`;
    console.log(`unarchived QA131 fixtures: ${fixtures.length}; control-tower trigger enabled: ${trig?.enabled}; stale failed proposals (>7d): ${stale?.n}`);
    if (!APPLY) return;
    const f = await founder();
    await sql.begin(async (tx) => {
      for (const p of fixtures) {
        await tx`update prospects set archived_at = now(), updated_at = now() where id = ${p.id}`;
        await writeAudit(tx, { userId: f.id, action: "prospect.archive", entity: "prospect", entityId: p.id as string, detail: { reason: "QA131 smoke fixture left unarchived by an interrupted run (operating review 2026-09-07)" } });
      }
      if (trig && trig.enabled) {
        await tx`update automation_triggers set enabled = false where id = ${trig.id}`;
        await writeAudit(tx, { userId: f.id, action: "automation_trigger.disable", entity: "automation_trigger", entityId: trig.id as string, detail: { reason: "Failed 14/14 mornings: no connected provider for notification.send_internal. Disabled as dead noise (operating review 2026-09-07); re-enable when a notification connector exists." } });
      }
    });
    const retired = await retireStaleFailedProposals(f, 7, "stale failed contact proposal (provider quota exhausted / source unreachable); operating review 2026-09-07");
    console.log(`archived ${fixtures.length} fixtures; trigger disabled: ${Boolean(trig?.enabled)}; retired ${retired} failed proposals`);
  } else {
    console.log("commands: gate-check | sales-block | waiting | backfill-owners | resolve | contact-queue | hygiene");
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
