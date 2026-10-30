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
import { OPERATOR_REPLIED_ACTIVITY, REPLY_SYNC_LOOKBACK_DAYS } from "@/lib/prospects/constants";
import { stripQuotedReply } from "@/lib/prospects/reply-classify";
import { applySequenceSignals, sequenceForProspect, userById } from "@/lib/prospects/followups";
import { recordProspectReply } from "@/lib/prospects/service";

export interface ReplySyncReport {
  recipients: number;
  candidates: number;
  recorded: number;
  bounces: number;
  /** Spec 173: operator replies sent by hand inside our threads. */
  operatorReplies: number;
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
/** Free-mail providers never identify a business: no domain-wide search. */
const FREE_MAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "msn.com",
  "aol.com", "icloud.com", "me.com", "mac.com", "comcast.net", "att.net", "verizon.net", "proton.me", "protonmail.com",
]);

/** Spec 172, pure: the distinct business domains of our recipients. */
export function companyDomains(emails: readonly string[]): string[] {
  const out = new Set<string>();
  for (const e of emails) {
    const d = e.split("@")[1]?.trim().toLowerCase();
    if (d && !FREE_MAIL_DOMAINS.has(d)) out.add(d);
  }
  return [...out].sort();
}

export function bouncedAddress(m: ParsedGmailMessage, known: Set<string>): string | null {
  const text = `${m.subject}\n${m.body}`.toLowerCase();
  for (const email of known) if (text.includes(email)) return email;
  return null;
}

export async function syncProspectReplies(now: Date = new Date()): Promise<ReplySyncReport> {
  const report: ReplySyncReport = { recipients: 0, candidates: 0, recorded: 0, bounces: 0, operatorReplies: 0, error: null };
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
  // Spec 172: a reply can come from someone else at the business (a
  // colleague the prospect forwarded to, an assistant). Our own sent threads
  // are the attribution key: any non-us message inside one is that
  // prospect's reply. Searched by the recipients' company domains; a message
  // outside our threads is never attributed.
  const threadRows = await sql`
    select s.gmail_thread_id, lower(s.recipient_email) as email
    from prospect_outreach_sends s
    where s.channel = 'gmail' and s.allowed and s.gmail_thread_id is not null
      and s.recipient_email is not null and s.sent_at >= ${since}
  `;
  const byThread = new Map<string, Recipient>();
  for (const t of threadRows) {
    const rcpt = recipients.get(t.email as string);
    if (rcpt) byThread.set(t.gmailThreadId as string, rcpt);
  }
  const seen = new Set<string>();

  // Replies, in batches of addresses (Gmail query length).
  const emails = [...recipients.keys()];
  for (let i = 0; i < emails.length; i += 25) {
    const batch = emails.slice(i, i + 25);
    const found = await search(`in:anywhere -in:sent newer_than:${days}d from:(${batch.join(" OR ")})`);
    if (found === null) { failed = true; continue; }
    for (const m of found) {
      const rcpt = recipients.get(addressOf(m.from));
      if (!rcpt) continue;
      seen.add(m.id);
      report.candidates += 1;
      if (await recordReply(rcpt, m)) report.recorded += 1;
    }
  }
  const sendAs = (gmail.config as { sendAsAddress?: string } | null)?.sendAsAddress?.toLowerCase() ?? null;
  const domains = companyDomains(emails);
  for (let i = 0; i < domains.length; i += 25) {
    const batch = domains.slice(i, i + 25);
    const found = await search(`in:anywhere -in:sent newer_than:${days}d from:(${batch.join(" OR ")})`);
    if (found === null) { failed = true; continue; }
    for (const m of found) {
      if (seen.has(m.id) || !m.threadId || addressOf(m.from) === sendAs) continue;
      const rcpt = byThread.get(m.threadId);
      if (!rcpt) continue;
      seen.add(m.id);
      report.candidates += 1;
      if (await recordReply(rcpt, m)) report.recorded += 1;
    }
  }
  // Spec 173: the operator's own replies in our threads (iPhone, Gmail)
  // complete the conversation record and count as answering a reply.
  const sentTargets = [...domains, ...emails.filter((e) => !domains.includes(e.split("@")[1] ?? ""))];
  for (let i = 0; i < sentTargets.length; i += 25) {
    const sent = await search(`in:sent newer_than:${days}d to:(${sentTargets.slice(i, i + 25).join(" OR ")})`);
    if (sent === null) { failed = true; continue; }
    for (const m of sent) {
      if (!m.threadId || (sendAs && addressOf(m.from) !== sendAs)) continue;
      const rcpt = byThread.get(m.threadId);
      if (!rcpt) continue;
      if (await recordOperatorReply(rcpt, m)) report.operatorReplies += 1;
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

/** Spec 173: log a reply the operator sent by hand inside our thread —
 * never one the system sent (those are ledger rows), never twice. */
async function recordOperatorReply(r: Recipient, m: ParsedGmailMessage): Promise<boolean> {
  const [tracked] = await sql`select 1 from prospect_outreach_sends where provider_message_id = ${m.id} limit 1`;
  if (tracked) return false;
  const [dup] = await sql`
    select 1 from prospect_activities
    where prospect_id = ${r.prospectId} and kind = ${OPERATOR_REPLIED_ACTIVITY} and detail->>'gmailMessageId' = ${m.id} limit 1`;
  if (dup) return false;
  const sentAt = m.date ? new Date(m.date) : new Date();
  await sql`
    insert into prospect_activities (prospect_id, kind, detail, actor_id, occurred_at)
    values (${r.prospectId}, ${OPERATOR_REPLIED_ACTIVITY},
      ${sql.json({ gmailMessageId: m.id, threadId: m.threadId, to: m.to ?? null, subject: m.subject, excerpt: stripQuotedReply(m.body).slice(0, 600) })},
      ${r.sentBy}, ${sentAt})`;
  log("info", "reply_sync.operator_reply_recorded", { prospectId: r.prospectId, gmailMessageId: m.id });
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
