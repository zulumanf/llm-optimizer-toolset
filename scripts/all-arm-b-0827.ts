/**
 * Operator decision 2026-08-26: ALL upcoming scheduled emails go Arm B
 * (no link, reply-CTA) — converts the 14 remaining link-CTA drafts for
 * Thu 8/27 + Fri 8/28. T1s get the established "reply send it" swap
 * (matches the already-staged B T1s, e.g. Housecats); the 4 Wilmington T2
 * arm-A drafts get the Crifasi-pattern B body with their own counts.
 * New draft supersedes on approve (QA gate runs); reschedules at the
 * original slot. Dry-run by default; --apply to write.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { approveOutreachDraft, createOutreachDraft, scheduleDraftSend } from "@/lib/prospects/service";

const APPLY = process.argv.includes("--apply");
const LINK = "(https?://|recommendedfirst\\.com|rcmnd|audit\\.)";
const PURPOSE =
  "Operator decision 2026-08-26: all upcoming sends switch to Arm B (no link, reply-CTA); body superseded, original slot kept.";

const T1_B_CTA =
  'I put every question and complete answer on one page, so you can search for your own name and check the counting yourself. No link — reply "send it" and I\'ll send the page over.';

/** Wilmington T2 arm-A → B bodies (Crifasi pattern, each prospect's counts). */
const T2_FINDING: Record<string, string> = {
  "Barrows and Associates": "Barrows and Associates came up in 0",
  "The Debbie Reed Team": "The Debbie Reed Team came up in 0",
  "Bryce Lingo & Shaun Tull Team": "Bryce Lingo & Shaun Tull Team came up in 0",
  "Mary Beth Adelman": "Mary Beth Adelman came up in 5 (1.4%) — absent from the other 349",
};
const t2Body = (greeting: string, finding: string): string => `${greeting}

Quick follow-up on my note from Tuesday — no link this time. A link from someone you haven't met is easy to skip, so here is the finding itself:

Across 354 monitored answers from OpenAI and Perplexity to Wilmington buyer and seller questions, ${finding}. The same answers do recommend other Wilmington names in response to those questions.

Reply "show me" and I'll paste three of those answers directly into this thread — about two minutes to read, and you can judge it without clicking anything.

—
Francisco Zuluaga · Recommended First
1399 Myrtle Ave, Brooklyn, NY 11237
If you'd rather not hear from us, reply "unsubscribe" and we will not contact you again.`;

function toArmB(business: string, channel: string, body: string): string | null {
  if (channel === "followup_email") {
    const finding = T2_FINDING[business];
    const greeting = body.split("\n")[0] ?? "Hi there,";
    return finding ? t2Body(greeting, finding) : null;
  }
  // T1: replace the link paragraph + "If it's useful..." CTA with the B CTA.
  const next = body.replace(
    /The full benchmark is here[^\n]*\n\nIf it's useful, reply "show me" and I'll walk you through it — 15 minutes\./,
    T1_B_CTA
  );
  return next === body ? null : next;
}

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };

  const rows = await sql`
    select d.id, d.prospect_id, d.channel, d.subject, d.body, d.contact_id, d.scheduled_send_at, p.business_name
    from outreach_drafts d join prospects p on p.id = d.prospect_id
    where d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at > now() and d.body ~* ${LINK}
    order by d.scheduled_send_at`;
  console.log(`${rows.length} link-CTA drafts to convert${APPLY ? "" : " (dry-run)"}`);
  let ok = 0;
  for (const r of rows) {
    const b = toArmB(r.businessName as string, r.channel as string, r.body as string);
    const tag = `${r.businessName} (${r.channel}, ${new Date(r.scheduledSendAt as Date).toISOString()})`;
    if (!b) { console.error(`SKIP no transform matched: ${tag}`); continue; }
    if (b.match(new RegExp(LINK, "i"))) { console.error(`SKIP still has link: ${tag}`); continue; }
    if (!APPLY) { console.log(`\n=== would convert ${tag}\n${b}`); ok++; continue; }
    const created = await createOutreachDraft(user, {
      prospectId: r.prospectId, channel: r.channel, contactId: r.contactId ?? undefined,
      subject: r.subject, body: b, cta: r.channel === "email" ? 'reply "send it"' : 'reply "show me"',
    });
    if (!created.ok) { console.error(`FAIL create: ${tag} — ${created.error.message}`); continue; }
    const approved = await approveOutreachDraft(user, { draftId: created.data.draftId });
    if (!approved.ok) { console.error(`FAIL approve (QA): ${tag} — ${approved.error.message}`); continue; }
    const sched = await scheduleDraftSend(user, {
      draftId: created.data.draftId, sendAt: r.scheduledSendAt, businessPurpose: PURPOSE,
    });
    if (!sched.ok) { console.error(`FAIL schedule: ${tag} — ${sched.error.message}`); continue; }
    console.log(`converted + approved + scheduled: ${tag} → draft ${created.data.draftId.slice(0, 8)}`);
    ok++;
  }
  console.log(`\n${ok}/${rows.length} ${APPLY ? "converted" : "ready"}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
