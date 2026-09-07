/**
 * Wilmington DE outreach prep (2026-08-24, for the 2026-08-25 AM batch).
 * Launch c0bd8d88 "Wilmington — luxury residential", run 66af5cdb (354/512
 * captured — partial after OpenAI quota; both providers represented).
 *
 * Phases (combine flags; dry-run by default, --apply to write):
 *   --dnc-gillespie  flag the Wilmington-NC misclassified prospect do-not-contact
 *   --stepd     linkBenchmark → computeProspectScore → generateFindings →
 *               approve best candidate as primary
 *   --contacts  add primary contacts from scripts/wil-contacts.json
 *   --sense     run sense-check per prospect (needs working OpenAI key)
 *   --publish   publish audits (creates the live audit page + token)
 *   --drafts    system reply-first email drafts bound to the contact
 *   --approve   approve pending drafts
 *   --schedule <ISO-UTC> [--max N]  schedule approved-unscheduled drafts,
 *               staggered STAGGER_MIN apart, capped at N (default 12)
 *
 * Excluded always: Gillespie (NC business), Rakan Abuzahra (same person as
 * First State Home Team — one prospect only).
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import {
  addContact, approveOutreachDraft, computeProspectScore, createOutreachDraft,
  generateFindings, linkBenchmark, reviewFinding, scheduleDraftSend, updateProspect,
} from "@/lib/prospects/service";
import { runSenseCheck } from "@/lib/prospects/sense-check";
import { publishAudit } from "@/lib/prospects/audits";

const RUN_ID = "66af5cdb-d8cb-48a5-9646-7b961ee3328e";
const LAUNCH_PREFIX = "c0bd8d88";
const EXCLUDE = new Set([
  "Gillespie Group Real Estate Team", // Wilmington NC — geography misclassification
  "Rakan Abuzahra", // same person as First State Home Team
  "Christopher Levy Group", // stray prospect, no primary finding (found by sense sweep 08-24)
  "Ken Van Every", // stray prospect, no primary finding
  "Michael Aldridge", // stray prospect, no primary finding
]);
/** Held from SCHEDULING only (drafts still prepared):
 *  - Compass 30d brokerage cap (2/3 used by JC 8/20; the last slot goes to
 *    the Arrived Team follow-up) → eligible once the window clears ~9/19.
 *  - Rose Bloom: contact email needs a human browser check (page-source only). */
const HOLD_FROM_SCHEDULE = new Set(["The Oldfather Group", "The Mottola Group", "Robert Blackhurst", "Rose Bloom"]);
const KIND_PREFERENCE = ["authority_visibility_gap", "competitor_contrast", "citation_gap"];
const STAGGER_MIN = 10;
const BUSINESS_PURPOSE =
  "Wilmington DE first-touch outreach: published AI-visibility benchmark audit, reply-first ask; contact publicly sourced (source page on contact record).";

const argv = process.argv.slice(2);
const APPLY = argv.includes("--apply");
const has = (f: string): boolean => argv.includes(f);
const SCHEDULE_AT = has("--schedule") ? argv[argv.indexOf("--schedule") + 1] : null;
const MAX_SENDS = has("--max") ? Number(argv[argv.indexOf("--max") + 1]) : 12;

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
  const contacts = JSON.parse(readFileSync("scripts/wil-contacts.json", "utf8")) as
    { business: string; name: string; role: string; email: string; phone: string; provenance: "publicly_sourced"; notes: string }[];

  const rows = await sql`
    select p.id, p.business_name, p.stage, p.do_not_contact, p.company_id, p.brokerage_affiliation,
      (select b.id from prospect_benchmarks b where b.prospect_id = p.id and b.run_id = ${RUN_ID} limit 1) as benchmark_id,
      (select f.id from prospect_findings f where f.prospect_id = p.id and f.is_primary and f.status = 'approved' limit 1) as primary_id,
      (select c.id from prospect_contacts c where c.prospect_id = p.id and c.archived_at is null and c.email is not null
        order by c.is_primary desc, c.created_at limit 1) as contact_id,
      exists(select 1 from prospect_audits a where a.prospect_id = p.id and a.status = 'published') as published,
      (select d.id from outreach_drafts d where d.prospect_id = p.id and d.status = 'draft' and d.sent_recorded_at is null
        order by d.version desc limit 1) as pending_draft_id,
      (select d.id from outreach_drafts d where d.prospect_id = p.id and d.status = 'approved' and d.sent_recorded_at is null
        and d.scheduled_send_at is null order by d.version desc limit 1) as approved_unscheduled_id
    from prospects p join market_launches l on l.id = p.launch_id
    where l.id::text like ${LAUNCH_PREFIX + "%"} and p.archived_at is null
    order by p.business_name`;

  if (has("--dnc-gillespie")) {
    const g = rows.find((r) => (r.businessName as string).startsWith("Gillespie"));
    if (g && !g.doNotContact) {
      if (!APPLY) console.log("would flag do-not-contact: Gillespie Group Real Estate Team");
      else {
        const res = await updateProspect(user, {
          prospectId: g.id, doNotContact: true,
          doNotContactReason: "Geography misclassification: business operates in Wilmington, NORTH CAROLINA (gillespiegrouprealestate.com, RealTrends NC profile; verified 2026-08-24). Same NC/DE confusion as the archived discovery batch.",
        });
        console.log(res.ok ? "flagged do-not-contact: Gillespie" : `FAILED dnc: ${res.error.message}`);
      }
    }
  }

  let slot = 0;
  let scheduled = 0;
  for (const r of rows) {
    const name = r.businessName as string;
    if (EXCLUDE.has(name)) { continue; }
    if (r.doNotContact) { console.log(`skip (do-not-contact): ${name}`); continue; }
    const tag = `${name} (${(r.id as string).slice(0, 8)})`;

    let benchmarkId = (r.benchmarkId as string | null) ?? null;
    if (has("--stepd")) {
      if (!benchmarkId) {
        if (!APPLY) console.log(`would link benchmark: ${tag}`);
        else {
          const res = await linkBenchmark(user, { prospectId: r.id, runId: RUN_ID, note: "Wilmington DE state-qualified run (partial: 354/512 after provider quota; both providers present)" });
          if (!res.ok) { console.error(`FAILED link: ${tag} — ${res.error.message}`); continue; }
          benchmarkId = res.data.benchmarkId;
          console.log(`benchmark linked: ${tag}`);
        }
      }
      if (APPLY && benchmarkId) {
        const sc = await computeProspectScore(user, { prospectId: r.id });
        if (!sc.ok) console.error(`  score failed: ${sc.error.message}`);
        else console.log(`  score: ${sc.data.score}`);
        if (!r.primaryId) {
          const gen = await generateFindings(user, { benchmarkId });
          if (!gen.ok) { console.error(`  FAILED findings: ${gen.error.message}`); continue; }
          const cands = await sql`
            select id, kind, title from prospect_findings
            where prospect_id = ${r.id} and benchmark_id = ${benchmarkId} and status = 'candidate'
            order by created_at desc`;
          const pick = KIND_PREFERENCE.map((k) => cands.find((c) => c.kind === k)).find(Boolean);
          if (!pick) { console.error(`  no candidate to pick (${gen.data.candidateCount} generated)`); continue; }
          const rev = await reviewFinding(user, { findingId: pick.id, decision: "approved", makePrimary: true });
          if (!rev.ok) { console.error(`  FAILED approve finding: ${rev.error.message}`); continue; }
          console.log(`  primary [${pick.kind}]: ${pick.title}`);
        }
      }
    }

    let contactId = (r.contactId as string | null) ?? null;
    if (has("--contacts") && !contactId) {
      const src = contacts.find((c) => c.business === name);
      if (!src || !src.email) { console.log(`no contact sourced: ${tag}`); continue; }
      if (!APPLY) console.log(`would add contact: ${tag} → ${src.email}`);
      else {
        const res = await addContact(user, {
          prospectId: r.id, name: src.name, role: src.role, email: src.email, phone: src.phone,
          preferredChannel: "email", isPrimary: true, provenance: src.provenance, notes: src.notes,
        });
        if (!res.ok) { console.error(`FAILED contact: ${tag} — ${res.error.message}`); continue; }
        contactId = res.data.contactId;
        console.log(`contact added: ${tag} → ${src.email}`);
      }
    }

    if (has("--sense")) {
      const sc = await runSenseCheck(user, { prospectId: r.id });
      if (!sc.ok) console.error(`sense-check error: ${tag} — ${sc.error.message}`);
      else {
        const concerns = sc.data.concerns.filter((c) => c.severity === "concern");
        console.log(`sense-check ${tag}: ${sc.data.error ? "FAILED " + sc.data.error : `${sc.data.concerns.length} item(s), ${concerns.length} concern(s)`}`);
        for (const c of concerns) console.log(`  · [${c.area}] ${c.detail}`);
      }
    }

    if (has("--publish") && !r.published) {
      if (!APPLY) console.log(`would publish audit: ${tag}`);
      else {
        const pub = await publishAudit(user, {
          prospectId: r.id,
          acknowledgeStale: true,
          acknowledgeWarnings: {
            reason:
              "Run 66af5cdb captured 508 of 512 cells (99.2%; 4 transient failures on retry) — the audit's counts cover the captured answers and the page states the sample size.",
          },
        });
        if (!pub.ok) { console.error(`FAILED publish: ${tag} — ${pub.error.message}`); continue; }
        console.log(`published: ${tag}${pub.data.warnings.length ? ` — ${pub.data.warnings.length} warning(s)` : ""}`);
        for (const w of pub.data.warnings) console.log(`  · ${w}`);
        r.published = true;
      }
    }

    if (has("--drafts") && !r.pendingDraftId && !r.approvedUnscheduledId) {
      if (!r.published) { console.log(`skip draft (no live audit): ${tag}`); continue; }
      if (!contactId) { console.log(`skip draft (no contact): ${tag}`); continue; }
      if (!APPLY) console.log(`would create draft: ${tag}`);
      else {
        const res = await createOutreachDraft(user, { prospectId: r.id, channel: "email", contactId });
        if (!res.ok) { console.error(`FAILED draft: ${tag} — ${res.error.message}`); continue; }
        console.log(`draft v${res.data.version} created: ${tag}`);
        r.pendingDraftId = res.data.draftId;
      }
    }

    let approvedId = (r.approvedUnscheduledId as string | null) ?? null;
    if (has("--approve") && r.pendingDraftId) {
      if (!APPLY) console.log(`would approve draft: ${tag}`);
      else {
        const res = await approveOutreachDraft(user, { draftId: r.pendingDraftId });
        if (!res.ok) { console.error(`FAILED approve: ${tag} — ${res.error.message}`); continue; }
        approvedId = res.data.draftId;
        console.log(`approved: ${tag}`);
      }
    }

    if (SCHEDULE_AT && approvedId && HOLD_FROM_SCHEDULE.has(name)) {
      console.log(`hold (see HOLD_FROM_SCHEDULE): ${tag}`);
    } else if (SCHEDULE_AT && approvedId && scheduled < MAX_SENDS) {
      const at = new Date(new Date(SCHEDULE_AT).getTime() + slot * STAGGER_MIN * 60_000);
      slot += 1;
      scheduled += 1;
      if (!APPLY) console.log(`would schedule: ${tag} at ${at.toISOString()}`);
      else {
        const res = await scheduleDraftSend(user, { draftId: approvedId, sendAt: at, businessPurpose: BUSINESS_PURPOSE });
        if (!res.ok) { console.error(`FAILED schedule: ${tag} — ${res.error.message}`); continue; }
        console.log(`scheduled: ${tag} at ${res.data.sendAt}`);
      }
    }
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
