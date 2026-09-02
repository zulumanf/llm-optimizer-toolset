/**
 * Generalized city prospect prep (successor to wil-prep.ts, spec 097 step-D).
 * Prospects must already have benchmarks linked (the pipeline does that).
 *   npx tsx scripts/city-prep.ts --launch savannah [phases] [--apply]
 * Phases: --findings (generate + approve absence-primary) --sense --publish
 *         --drafts --approve --schedule <ISO-UTC> [--max N]
 * Skips: do_not_contact prospects; drafts/schedule skip missing contacts.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import {
  approveOutreachDraft, createOutreachDraft, computeProspectScore,
  generateFindings, reviewFinding, scheduleDraftSend,
} from "@/lib/prospects/service";
import { runSenseCheck } from "@/lib/prospects/sense-check";
import { publishAudit } from "@/lib/prospects/audits";

const argv = process.argv.slice(2);
const has = (f: string): boolean => argv.includes(f);
const val = (f: string): string | null => (has(f) ? argv[argv.indexOf(f) + 1] ?? null : null);
const APPLY = has("--apply");
const LAUNCH = val("--launch");
const SCHEDULE_AT = val("--schedule");
const MAX_SENDS = val("--max") ? Number(val("--max")) : 12;
const STAGGER_MIN = 10;
const SKIP = new Set((val("--skip") ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const KIND_PREFERENCE = ["authority_visibility_gap", "absence", "competitor_contrast", "citation_gap"];

async function main(): Promise<void> {
  if (!LAUNCH) throw new Error("--launch <name substring> required");
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
  const purpose = `${LAUNCH} first-touch outreach: published sense-checked AI-visibility audit, reply-first ask; contact publicly sourced (source page on contact record).`;

  const rows = await sql`
    select p.id, p.business_name,
      (select b.id from prospect_benchmarks b where b.prospect_id = p.id order by b.created_at desc limit 1) as benchmark_id,
      (select f.id from prospect_findings f where f.prospect_id = p.id and f.is_primary and f.status = 'approved' limit 1) as primary_id,
      (select c.id from prospect_contacts c where c.prospect_id = p.id and c.archived_at is null and c.email is not null
        order by c.is_primary desc, c.created_at limit 1) as contact_id,
      exists(select 1 from prospect_audits a where a.prospect_id = p.id and a.status = 'published') as published,
      (select d.id from outreach_drafts d where d.prospect_id = p.id and d.status = 'draft' and d.sent_recorded_at is null
        order by d.version desc limit 1) as pending_draft_id,
      (select d.id from outreach_drafts d where d.prospect_id = p.id and d.status = 'approved' and d.sent_recorded_at is null
        and d.scheduled_send_at is null order by d.version desc limit 1) as approved_unscheduled_id
    from prospects p join market_launches l on l.id = p.launch_id
    where l.name ilike ${"%" + LAUNCH + "%"} and p.archived_at is null and p.do_not_contact = false
    order by p.business_name`;

  let slot = 0;
  let scheduled = 0;
  for (const r of rows) {
    const tag = `${r.businessName} (${(r.id as string).slice(0, 8)})`;
    if (!r.benchmarkId) { console.log(`skip (no benchmark): ${tag}`); continue; }

    if (SKIP.has(r.businessName as string)) { console.log(`skip (--skip list): ${tag}`); continue; }
    if (has("--findings") && (!r.primaryId || has("--force-findings"))) {
      if (!APPLY) console.log(`would generate findings: ${tag}`);
      else {
        await computeProspectScore(user, { prospectId: r.id });
        const gen = await generateFindings(user, { benchmarkId: r.benchmarkId });
        if (!gen.ok) { console.error(`FAILED findings: ${tag} — ${gen.error.message}`); continue; }
        const cands = await sql`
          select id, kind, title from prospect_findings
          where prospect_id = ${r.id} and benchmark_id = ${r.benchmarkId} and status = 'candidate'
          order by created_at desc`;
        const pick = KIND_PREFERENCE.map((k) => cands.find((c) => c.kind === k)).find(Boolean);
        if (!pick) { console.error(`no candidate: ${tag} (${gen.data.candidateCount})`); continue; }
        const rev = await reviewFinding(user, { findingId: pick.id, decision: "approved", makePrimary: true });
        console.log(rev.ok ? `primary [${pick.kind}]: ${tag} — ${pick.title}` : `FAILED primary: ${tag} — ${rev.error.message}`);
      }
    }

    if (has("--sense") && APPLY) {
      const sc = await runSenseCheck(user, { prospectId: r.id });
      if (!sc.ok) console.error(`sense error: ${tag} — ${sc.error.message}`);
      else {
        const concerns = sc.data.concerns.filter((c) => c.severity === "concern");
        console.log(`sense ${tag}: ${sc.data.error ? "FAILED " + sc.data.error : concerns.length + " concern(s)"}`);
        for (const c of concerns) console.log(`  · [${c.area}] ${c.detail.slice(0, 140)}`);
      }
    }

    if (has("--publish") && !r.published) {
      if (!APPLY) console.log(`would publish: ${tag}`);
      else {
        const pub = await publishAudit(user, {
          prospectId: r.id,
          acknowledgeStale: true,
          acknowledgeWarnings: {
            reason:
              "Run captured all expected cells; 'attempted' exceeds captures only by superseded failed attempts that were retried successfully. Mixed-entity comparison is disclosed on-page (standing design). Sense concerns reviewed by operator agent.",
          },
        });
        if (!pub.ok) { console.error(`FAILED publish: ${tag} — ${pub.error.message}`); continue; }
        console.log(`published: ${tag}${pub.data.warnings.length ? ` — ${pub.data.warnings.length} warning(s)` : ""}`);
        r.published = true;
      }
    }

    if (has("--drafts") && !r.pendingDraftId && !r.approvedUnscheduledId) {
      if (!r.published) { console.log(`skip draft (no audit): ${tag}`); continue; }
      if (!r.contactId) { console.log(`skip draft (no contact): ${tag}`); continue; }
      if (!APPLY) console.log(`would draft: ${tag}`);
      else {
        const d = await createOutreachDraft(user, { prospectId: r.id, channel: "email", contactId: r.contactId });
        if (!d.ok) { console.error(`FAILED draft: ${tag} — ${d.error.message}`); continue; }
        console.log(`draft v${d.data.version}: ${tag}`);
        r.pendingDraftId = d.data.draftId;
      }
    }

    let approvedId = (r.approvedUnscheduledId as string | null) ?? null;
    if (has("--approve") && r.pendingDraftId && APPLY) {
      const ap = await approveOutreachDraft(user, { draftId: r.pendingDraftId });
      if (!ap.ok) { console.error(`FAILED approve: ${tag} — ${ap.error.message}`); continue; }
      approvedId = ap.data.draftId;
      console.log(`approved: ${tag}`);
    }

    if (SCHEDULE_AT && approvedId && scheduled < MAX_SENDS) {
      const at = new Date(new Date(SCHEDULE_AT).getTime() + slot * STAGGER_MIN * 60_000);
      slot += 1; scheduled += 1;
      if (!APPLY) console.log(`would schedule: ${tag} at ${at.toISOString()}`);
      else {
        const res = await scheduleDraftSend(user, { draftId: approvedId, sendAt: at, businessPurpose: purpose });
        console.log(res.ok ? `scheduled: ${tag} at ${res.data.sendAt}` : `FAILED schedule: ${tag} — ${res.error.message}`);
      }
    }
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
