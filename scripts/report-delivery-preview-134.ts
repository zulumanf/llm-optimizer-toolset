/**
 * Spec 134 — UNSENT preview of the private-report delivery email for a
 * Ryan-shaped record. Read-only: no draft, no send, no state change. Prints
 * the plain-text part (with the functional invitation URL) and the HTML
 * part (invitation rendered as "Private report for <business>").
 *
 *   npx tsx scripts/report-delivery-preview-134.ts [prospectId]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { renderReportDelivery, lintReportDelivery } from "@/lib/prospects/report-handoff";
import { sequenceForProspect, firstNameFrom, footerTailFrom, prospectEntityType } from "@/lib/prospects/followups";
import { slugifyBusinessName } from "@/lib/prospects/links";
import { invitationLinkLabels } from "@/lib/prospects/report-access";
import { reportInvitationUrl } from "@/lib/prospects/urls";
import { plainTextToTrackedHtml } from "@/lib/text/html";
import type { AuditMismatchBlock } from "@/lib/prospects/audit-mismatch";
import type { MismatchEvidenceSnapshot } from "@/lib/prospects/mismatch";

const RYAN = "ba4860d6-3118-4a42-8af1-7bedbb2e27a0";

async function main() {
  const prospectId = process.argv[2] ?? RYAN;
  const [p] = await sql`select business_name from prospects where id = ${prospectId}`;
  if (!p) throw new Error("prospect not found");
  // Before migration 107 the column does not exist; preview the slug it will assign.
  let reportSlug: string | null = null;
  try {
    const [r] = await sql`select report_slug from prospects where id = ${prospectId}`;
    reportSlug = (r?.reportSlug as string | null) ?? null;
  } catch { reportSlug = null; }
  const [link] = await sql`select key from prospect_audit_links where prospect_id = ${prospectId} and revoked_at is null`;
  const [audit] = await sql`select snapshot from prospect_audits where prospect_id = ${prospectId} and status = 'published'`;
  if (!link || !audit) throw new Error("needs an active link and a published audit");
  const block = (audit.snapshot as { mismatch?: AuditMismatchBlock }).mismatch;
  if (!block) throw new Error("published audit is not a mismatch private report");
  // Evidence: the follow-up sequence when enrolled, else the prospect's
  // latest draft carrying a frozen evidence snapshot (Ryan was handled by hand).
  const seq = await sequenceForProspect(prospectId);
  const [fallback] = await sql`
    select evidence_snapshot from outreach_drafts where prospect_id = ${prospectId} and evidence_snapshot is not null
    order by created_at desc limit 1`;
  const evidence = (seq?.evidenceSnapshot ?? (fallback?.evidenceSnapshot as MismatchEvidenceSnapshot | undefined)) ?? null;
  if (!evidence) throw new Error("no frozen evidence snapshot for this prospect");
  const entityType = await prospectEntityType(evidence);
  if (!entityType) throw new Error("entity type unknown");
  const [t1] = seq
    ? await sql`select body from outreach_drafts where id = ${seq.touch1DraftId}`
    : await sql`select body from outreach_drafts where prospect_id = ${prospectId} and sent_recorded_at is not null order by sent_recorded_at asc limit 1`;
  const t1Body = (t1?.body as string) ?? "";
  // Slug as it will be after migration 107 (preview only — nothing is written).
  const slug = reportSlug ?? slugifyBusinessName(p.businessName as string);
  const url = reportInvitationUrl(slug, link.key as string);
  if (!url) throw new Error("APP_URL not set");
  const rendered = renderReportDelivery({ firstName: firstNameFrom(t1Body), brandedUrl: url, block, snapshot: evidence, entityType, footerTail: footerTailFrom(t1Body) });
  const lint = lintReportDelivery(rendered.body, url);
  const html = plainTextToTrackedHtml(rendered.body, null, invitationLinkLabels(rendered.body, p.businessName as string));
  const redact = (s: string) => s.split(link.key as string).join("<invitation-key>");
  console.log("=== TEXT PART (unsent preview; key redacted for the console) ===\n" + redact(rendered.body));
  console.log("\n=== HTML PART ===\n" + redact(html));
  console.log("\n=== LINT ===", lint.length ? lint : "clean");
  console.log(`\nclean URL after one click: ${url.slice(0, url.lastIndexOf("/"))}`);
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
