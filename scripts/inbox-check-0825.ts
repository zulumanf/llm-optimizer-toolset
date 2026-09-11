/**
 * One-off ops check (2026-08-25): did the AM batch deliver?
 * 1. Lists today's rows from prospect_outreach_sends.
 * 2. Uses the platform Gmail connection to look for bounces + replies.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { resolveSecrets } from "@/lib/connectors/credentials";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

async function main() {
  const sends = (await sql`
    select s.sent_at, s.recipient_email, s.provider_message_id, d.subject, d.status as draft_status
    from prospect_outreach_sends s
    join outreach_drafts d on d.id = s.draft_id
    where s.sent_at >= '2026-08-25T00:00:00Z'
    order by s.sent_at
  `) as {
    sentAt: string;
    recipientEmail: string | null;
    providerMessageId: string | null;
    subject: string | null;
    draftStatus: string;
  }[];
  console.log(`=== Ledger: ${sends.length} sends today ===`);
  for (const s of sends) {
    console.log(
      `${String(s.sentAt)}  ${s.recipientEmail}  msgId=${s.providerMessageId ?? "NULL"}  draft=${s.draftStatus}  "${(s.subject ?? "").slice(0, 60)}"`
    );
  }

  const conns = (await sql`
    select id, config from connector_connections
    where provider = 'gmail' and project_id is null and status = 'active'
    limit 1
  `) as { id: string; config: { clientId?: string; clientSecret?: string } }[];
  if (conns.length === 0) {
    console.log("No active platform Gmail connection — cannot read inbox.");
    return;
  }
  const conn = conns[0]!;
  const secrets = await resolveSecrets(conn.id);
  let token = secrets.accessToken;
  if (secrets.refreshToken && conn.config.clientId && conn.config.clientSecret) {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: conn.config.clientId,
        client_secret: conn.config.clientSecret,
        refresh_token: secrets.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const j = (await r.json()) as { access_token?: string };
    if (j.access_token) token = j.access_token;
    else console.log(`WARN: token refresh failed (${r.status}) — trying stored token`);
  }
  const auth = { Authorization: `Bearer ${token}` };

  async function search(q: string): Promise<string[]> {
    const res = await fetch(`${GMAIL}/messages?q=${encodeURIComponent(q)}&maxResults=50`, {
      headers: auth,
    });
    if (!res.ok) {
      console.log(`Gmail search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return [];
    }
    const j = (await res.json()) as { messages?: { id: string }[] };
    return (j.messages ?? []).map((m) => m.id);
  }

  async function headersOf(id: string) {
    const res = await fetch(
      `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&metadataHeaders=X-Failed-Recipients`,
      { headers: auth }
    );
    if (!res.ok) return null;
    const j = (await res.json()) as {
      payload?: { headers?: { name: string; value: string }[] };
      snippet?: string;
    };
    const h = new Map((j.payload?.headers ?? []).map((x) => [x.name.toLowerCase(), x.value]));
    return {
      from: h.get("from") ?? "",
      subject: h.get("subject") ?? "",
      date: h.get("date") ?? "",
      failed: h.get("x-failed-recipients") ?? "",
      snippet: (j.snippet ?? "").slice(0, 160),
    };
  }

  console.log("\n=== Bounces (mailer-daemon/postmaster, last 2 days) ===");
  const bounceIds = await search("from:(mailer-daemon OR postmaster) newer_than:2d");
  if (bounceIds.length === 0) console.log("none");
  for (const id of bounceIds) {
    const m = await headersOf(id);
    if (m) console.log(`BOUNCE ${m.date} | failed=${m.failed} | ${m.subject} | ${m.snippet}`);
  }

  console.log("\n=== Replies from today's recipients ===");
  const recipients = [...new Set(sends.map((s) => s.recipientEmail).filter(Boolean))] as string[];
  if (recipients.length === 0) console.log("(no recipients in ledger)");
  for (const batchStart of [0, 20, 40]) {
    const batch = recipients.slice(batchStart, batchStart + 20);
    if (batch.length === 0) break;
    const ids = await search(`in:inbox newer_than:2d from:(${batch.join(" OR ")})`);
    for (const id of ids) {
      const m = await headersOf(id);
      if (m) console.log(`REPLY ${m.date} | ${m.from} | ${m.subject} | ${m.snippet}`);
    }
  }
  if (recipients.length > 0) console.log("(reply scan done)");
}

main().then(() => process.exit(0));
