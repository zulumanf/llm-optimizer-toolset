/**
 * Campaign week 2026-09-08: bring freshly generated competitive-mismatch
 * Touch 1 drafts into the form the experiment has actually sent since
 * 2026-08-31 (operator decision: no em-dashes in outbound copy). Exactly
 * three deterministic substitutions, nothing else: subject "Name — City" →
 * "Name - City", opener "Name —" → "Name,", signature separator "—" → "--".
 * The rewrite is a NEW version (parent = the template render) carrying the
 * same frozen evidence snapshot and template version; it is re-QA'd,
 * approved and scheduled at the original slot, and the em-dash version is
 * superseded. Any other em-dash in a body fails closed.
 *
 * Run: npx tsx scripts/campaign-0908-rewrite-emdash.ts [--dry]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { MISMATCH_TEMPLATE_VERSION } from "@/lib/prospects/constants";
import { qaDraft } from "@/lib/prospects/draft-qa";
import { approveOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";

const dry = process.argv.includes("--dry");

function rewrite(subject: string, body: string): { subject: string; body: string } | string {
  const lines = body.split("\n");
  const opener = lines[0]!.match(/^(\S[^—\n]*?)\s+—$/);
  if (!opener) return `opener "${lines[0]}" is not the "Name —" form`;
  lines[0] = `${opener[1]},`;
  const sep = lines.findIndex((l, i) => i > 0 && l.trim() === "—");
  if (sep < 0) return "no signature separator line";
  lines[sep] = "--";
  const outBody = lines.join("\n");
  if (outBody.includes("—")) return "body still contains an em-dash outside the two known places";
  const outSubject = subject.replace(" — ", " - ");
  if (outSubject.includes("—")) return "subject still contains an em-dash";
  return { subject: outSubject, body: outBody };
}

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = { id: u!.id, email: u!.email, name: u!.name, role: u!.role } as CurrentUser;
  const rows = await sql`
    select d.id, d.prospect_id, d.finding_id, d.channel, d.contact_id, d.version, d.subject, d.body, d.tone, d.cta,
      d.prompt_version, d.evidence_snapshot, d.scheduled_send_at, d.scheduled_business_purpose, p.business_name
    from outreach_drafts d join prospects p on p.id = d.prospect_id
    where d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at >= now()
      and d.prompt_version = ${MISMATCH_TEMPLATE_VERSION} and d.sequence_id is null and (d.subject like '%—%' or d.body like '%—%')
    order by d.scheduled_send_at`;
  console.log(`${dry ? "DRY" : "APPLY"} · ${rows.length} scheduled em-dash drafts`);
  const failures: string[] = [];
  for (const r of rows) {
    const out = rewrite(r.subject as string, r.body as string);
    if (typeof out === "string") { failures.push(`${r.businessName}: ${out}`); continue; }
    console.log(`  ${(r.businessName as string).padEnd(36)} "${r.subject}" → "${out.subject}" · opener "${out.body.split("\n")[0]}"`);
    if (dry) continue;
    const [v] = await sql`select coalesce(max(version), 0)::int as v from outreach_drafts where prospect_id = ${r.prospectId} and channel = ${r.channel}`;
    const [child] = await sql`
      insert into outreach_drafts (prospect_id, finding_id, channel, contact_id, version, parent_id, subject, body, tone, cta,
        generated_by, prompt_version, evidence_snapshot, status, created_by)
      values (${r.prospectId}, ${r.findingId}, ${r.channel}, ${r.contactId}, ${Number(v!.v) + 1}, ${r.id}, ${out.subject}, ${out.body}, ${r.tone}, ${r.cta},
        'system', ${r.promptVersion}, ${sql.json(r.evidenceSnapshot as never)}, 'draft', ${user.id})
      returning id`;
    const id = child!.id as string;
    const issues = await qaDraft(id);
    if (issues.length) { failures.push(`${r.businessName}: QA ${issues.map((i) => `[${i.check}] ${i.detail}`).join(" ")}`); await sql`update outreach_drafts set status = 'superseded' where id = ${id}`; continue; }
    const ap = await approveOutreachDraft(user, { draftId: id });
    if (!ap.ok) { failures.push(`${r.businessName}: approve ${ap.error.message}`); continue; }
    // Free the slot before re-taking it so the cap timeline never double counts.
    await sql`update outreach_drafts set status = 'superseded', scheduled_send_at = null, send_claimed_at = null,
      last_send_error = 'Superseded 2026-09-06: em-dash render replaced by the sent form (subject hyphen, "Name," opener, "--" separator).' where id = ${r.id}`;
    const sc = await scheduleDraftSend(user, { draftId: id, sendAt: new Date(r.scheduledSendAt as Date), businessPurpose: r.scheduledBusinessPurpose as string });
    if (!sc.ok) { failures.push(`${r.businessName}: schedule ${sc.error.message}`); continue; }
    console.log(`    → v${Number(v!.v) + 1} ${id.slice(0, 8)} scheduled ${new Date(r.scheduledSendAt as Date).toISOString()}`);
  }
  if (failures.length) { console.error("FAILURES\n" + failures.join("\n")); process.exitCode = 1; }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
