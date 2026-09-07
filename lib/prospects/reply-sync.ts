/**
 * Gmail reply ingestion (spec 127, closes the spec 099/125 gap). Every
 * worker tick searches the platform mailbox for mail from ledger
 * recipients and from mailer-daemon, records new inbound messages through
 * the reply ledger (deterministic classification, idempotent on the Gmail
 * message id), marks bounced contacts do-not-contact, and stamps the
 * connection's last_sync_at — the freshness signal the follow-up
 * preflight requires before any Touch 2/3 leaves.
 */
import { sql } from "@/db/client";
import * as connectors from "@/db/connectors";
import { executeCapability } from "@/lib/connectors/execute";
import type { ParsedGmailMessage } from "@/lib/connectors/adapters/google";
import { log } from "@/lib/logger";
import { REPLY_SYNC_LOOKBACK_DAYS } from "@/lib/prospects/constants";
import { stripQuotedReply } from "@/lib/prospects/reply-classify";
import { applySequenceSignals, sequenceForProspect, userById } from "@/lib/prospects/followups";
import { recordProspectReply } from "@/lib/prospects/service";

export interface ReplySyncReport {
  recipients: number;
  candidates: number;
  recorded: number;
  bounces: number;
  error: string | null;
}

interface Recipient {
  email: string;
  prospectId: string;
  contactId: string | null;
  sendId: string;
  sentBy: string;
  lastSentAt: Date;
}

function addressOf(from: string): string {
  const m = from.match(/<([^>]+)>/);
  return (m ? m[1]! : from).trim().toLowerCase();
}

async function search(q: string): Promise<ParsedGmailMessage[] | null> {
  const res = await executeCapability<{ messages: ParsedGmailMessage[] }>({
    capability: "email.search_messages", projectId: null, provider: "gmail", mode: "live",
    input: { q, maxResults: 100 },
  });
  if (!res.ok) {
    log("warn", "reply_sync.search_failed", { q: q.slice(0, 80), error: res.error ?? res.errorCode });
    return null;
  }
  return res.data?.messages ?? [];
}

/** Extract the bounced address from a delivery-failure message. */
export function bouncedAddress(m: ParsedGmailMessage, known: Set<string>): string | null {
  const text = `${m.subject}\n${m.body}`.toLowerCase();
  for (const email of known) if (text.includes(email)) return email;
  return null;
}

export async function syncProspectReplies(now: Date = new Date()): Promise<ReplySyncReport> {
  const report: ReplySyncReport = { recipients: 0, candidates: 0, recorded: 0, bounces: 0, error: null };
  const gmail = await connectors.connectionFor({ projectId: null, provider: "gmail" });
  if (!gmail) {
    report.error = "no gmail connection";
    return report;
  }
  const since = new Date(now.getTime() - REPLY_SYNC_LOOKBACK_DAYS * 86_400_000);
  const rows = await sql`
    select distinct on (lower(s.recipient_email)) lower(s.recipient_email) as email,
      s.prospect_id, d.contact_id, s.id as send_id, s.sent_by, s.sent_at
    from prospect_outreach_sends s
    left join outreach_drafts d on d.id = s.draft_id
    where s.channel = 'gmail' and s.allowed and s.recipient_email is not null and s.sent_at >= ${since}
    order by lower(s.recipient_email), s.sent_at desc
  `;
  const recipients = new Map<string, Recipient>(
    rows.map((r) => [r.email as string, {
      email: r.email as string, prospectId: r.prospectId as string, contactId: (r.contactId as string | null) ?? null,
      sendId: r.sendId as string, sentBy: r.sentBy as string, lastSentAt: new Date(r.sentAt as Date),
    }])
  );
  report.recipients = recipients.size;
  const days = REPLY_SYNC_LOOKBACK_DAYS;
  let failed = false;

  // Replies, in batches of addresses (Gmail query length).
  const emails = [...recipients.keys()];
  for (let i = 0; i < emails.length; i += 25) {
    const batch = emails.slice(i, i + 25);
    const found = await search(`in:anywhere -in:sent newer_than:${days}d from:(${batch.join(" OR ")})`);
    if (found === null) { failed = true; continue; }
    for (const m of found) {
      const rcpt = recipients.get(addressOf(m.from));
      if (!rcpt) continue;
      report.candidates += 1;
      if (await recordReply(rcpt, m)) report.recorded += 1;
    }
  }
  // Bounces.
  const daemons = await search(`in:anywhere newer_than:${days}d from:(mailer-daemon OR postmaster)`);
  if (daemons === null) failed = true;
  for (const m of daemons ?? []) {
    const email = bouncedAddress(m, new Set(emails));
    if (!email) continue;
    const rcpt = recipients.get(email)!;
    if (await recordBounce(rcpt, m)) report.bounces += 1;
  }
  if (failed) {
    report.error = "one or more Gmail searches failed; last_sync_at not advanced";
    return report;
  }
  await sql.begin(async (tx) => {
    await connectors.touchLastSync(tx, gmail.id);
  });
  return report;
}

async function recordReply(r: Recipient, m: ParsedGmailMessage): Promise<boolean> {
  const receivedAt = m.date ? new Date(m.date) : new Date();
  if (receivedAt.getTime() < r.lastSentAt.getTime() - 86_400_000 * REPLY_SYNC_LOOKBACK_DAYS) return false;
  const [dup] = await sql`select id from prospect_replies where gmail_message_id = ${m.id}`;
  if (dup) return false;
  const text = stripQuotedReply(m.body).slice(0, 20000) || m.subject;
  const [send] = await sql`
    select id from prospect_outreach_sends where prospect_id = ${r.prospectId} and allowed and sent_at <= ${receivedAt}
    order by sent_at desc limit 1
  `;
  const user = await userById(r.sentBy);
  if (!user) return false;
  const res = await recordProspectReply(user, {
    prospectId: r.prospectId,
    contactId: r.contactId ?? undefined,
    sendId: ((send?.id as string | null) ?? r.sendId) || undefined,
    bodyText: text,
    receivedAt,
    gmailMessageId: m.id,
  });
  if (!res.ok) {
    log("warn", "reply_sync.record_failed", { prospectId: r.prospectId, gmailMessageId: m.id, error: res.error.message });
    return false;
  }
  log("info", "reply_sync.recorded", { prospectId: r.prospectId, classification: res.data.classification, gmailMessageId: m.id });
  const seq = await sequenceForProspect(r.prospectId);
  if (seq) await applySequenceSignals(seq.id, new Date());
  return true;
}

async function recordBounce(r: Recipient, m: ParsedGmailMessage): Promise<boolean> {
  if (!r.contactId) return false;
  const rows = await sql`
    update prospect_contacts set do_not_contact = true,
      do_not_contact_reason = ${`hard_bounce ${(m.date ?? "").slice(0, 10)}: delivery failure reported by ${addressOf(m.from)} (${m.id}). Re-source before contacting.`},
      updated_at = now()
    where id = ${r.contactId} and not do_not_contact
    returning id
  `;
  if (rows.length === 0) return false;
  log("warn", "reply_sync.bounce", { prospectId: r.prospectId, email: r.email, gmailMessageId: m.id });
  const seq = await sequenceForProspect(r.prospectId);
  if (seq) await applySequenceSignals(seq.id, new Date());
  return true;
}
