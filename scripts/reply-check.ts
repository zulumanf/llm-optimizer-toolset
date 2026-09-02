/**
 * Spec 125: reply visibility until the Gmail ingestion worker (spec 099) exists.
 * Scans the platform Gmail inbox for messages from outreach recipients, matches
 * them to prospect/contact/send, and prints them. With --record, fetches the
 * plain-text body and records each via recordProspectReply (spec 124 auto-
 * classification + unsubscribe suppression), skipping already-recorded replies
 * (same prospect, received_at within ±3 min). Bounces are report-only.
 *
 * Usage: npx tsx scripts/reply-check.ts [--days N] [--record]
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { resolveSecrets } from "@/lib/connectors/credentials";
import { recordProspectReply } from "@/lib/prospects/service";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const RECORD = process.argv.includes("--record");
const daysArg = process.argv.indexOf("--days");
const DAYS = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 14 : 14;

interface Recipient {
  email: string;
  prospectId: string;
  businessName: string;
  contactId: string | null;
  sendId: string;
}

async function gmailToken(): Promise<string | null> {
  const conns = (await sql`
    select id, config from connector_connections
    where provider = 'gmail' and project_id is null and revoked_at is null
    order by created_at desc
    limit 1
  `) as { id: string; config: { clientId?: string; clientSecret?: string } }[];
  const conn = conns[0];
  if (!conn) return null;
  const secrets = await resolveSecrets(conn.id);
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
    if (j.access_token) return j.access_token;
    console.log(`WARN: token refresh failed (${r.status}) — trying stored token`);
  }
  return secrets.accessToken ?? null;
}

function decodePart(data: string): string {
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

interface GmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: GmailPart[];
}

function plainText(part: GmailPart): string | null {
  if (part.mimeType === "text/plain" && part.body?.data) return decodePart(part.body.data);
  for (const p of part.parts ?? []) {
    const t = plainText(p);
    if (t) return t;
  }
  return null;
}

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = {
    id: u.id as string,
    email: u.email as string,
    name: u.name as string,
    role: u.role as CurrentUser["role"],
  };

  // Latest allowed send per recipient email, with contact match where one exists.
  const recipients = (await sql`
    select distinct on (lower(s.recipient_email))
      lower(s.recipient_email) as email, s.prospect_id, p.business_name, s.id as send_id,
      (select c.id from prospect_contacts c
        where c.prospect_id = s.prospect_id and lower(c.email) = lower(s.recipient_email)
          and c.archived_at is null limit 1) as contact_id
    from prospect_outreach_sends s
    join prospects p on p.id = s.prospect_id
    where s.channel = 'gmail' and s.allowed and s.recipient_email is not null
    order by lower(s.recipient_email), s.sent_at desc
  `) as { email: string; prospectId: string; businessName: string; sendId: string; contactId: string | null }[];
  const byEmail = new Map<string, Recipient>(
    recipients.map((r) => [r.email, { ...r, contactId: r.contactId }])
  );
  console.log(`${byEmail.size} recipient addresses in ledger; scanning last ${DAYS}d…`);

  const token = await gmailToken();
  if (!token) {
    console.log("No active platform Gmail connection — cannot read inbox.");
    return;
  }
  const auth = { Authorization: `Bearer ${token}` };

  async function search(q: string): Promise<string[]> {
    const res = await fetch(`${GMAIL}/messages?q=${encodeURIComponent(q)}&maxResults=100`, {
      headers: auth,
    });
    if (!res.ok) {
      console.log(`Gmail search failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
      return [];
    }
    const j = (await res.json()) as { messages?: { id: string }[] };
    return (j.messages ?? []).map((m) => m.id);
  }

  console.log("\n=== Bounces (report only) ===");
  for (const id of await search(`from:(mailer-daemon OR postmaster) newer_than:${DAYS}d`)) {
    const res = await fetch(
      `${GMAIL}/messages/${id}?format=metadata&metadataHeaders=Date&metadataHeaders=Subject&metadataHeaders=X-Failed-Recipients`,
      { headers: auth }
    );
    if (!res.ok) continue;
    const j = (await res.json()) as {
      payload?: { headers?: { name: string; value: string }[] };
      snippet?: string;
    };
    const h = new Map((j.payload?.headers ?? []).map((x) => [x.name.toLowerCase(), x.value]));
    console.log(
      `BOUNCE ${h.get("date")} | failed=${h.get("x-failed-recipients") ?? "?"} | ${(j.snippet ?? "").slice(0, 120)}`
    );
  }

  console.log("\n=== Replies ===");
  const emails = [...byEmail.keys()];
  let found = 0;
  let recorded = 0;
  for (let i = 0; i < emails.length; i += 20) {
    const batch = emails.slice(i, i + 20);
    for (const id of await search(`in:inbox newer_than:${DAYS}d from:(${batch.join(" OR ")})`)) {
      const res = await fetch(`${GMAIL}/messages/${id}?format=full`, { headers: auth });
      if (!res.ok) continue;
      const j = (await res.json()) as {
        payload?: GmailPart & { headers?: { name: string; value: string }[] };
        snippet?: string;
        internalDate?: string;
      };
      const h = new Map((j.payload?.headers ?? []).map((x) => [x.name.toLowerCase(), x.value]));
      const fromRaw = h.get("from") ?? "";
      const fromEmail = (fromRaw.match(/<([^>]+)>/)?.[1] ?? fromRaw).trim().toLowerCase();
      const match = byEmail.get(fromEmail);
      if (!match) continue;
      found += 1;
      const receivedAt = new Date(Number(j.internalDate ?? Date.now()));
      const body = (j.payload ? plainText(j.payload) : null) ?? j.snippet ?? "";
      console.log(
        `REPLY ${receivedAt.toISOString()} | ${match.businessName} <${fromEmail}> | "${h.get("subject")}" | ${body.slice(0, 120).replace(/\s+/g, " ")}`
      );
      if (!RECORD) continue;
      const [dupe] = await sql`
        select id from prospect_replies
        where prospect_id = ${match.prospectId}
          and abs(extract(epoch from received_at - ${receivedAt}::timestamptz)) < 180
        limit 1
      `;
      if (dupe) {
        console.log("  (already recorded — skipped)");
        continue;
      }
      const result = await recordProspectReply(user, {
        prospectId: match.prospectId,
        contactId: match.contactId ?? undefined,
        sendId: match.sendId,
        bodyText: body.slice(0, 20000) || "(empty body)",
        receivedAt,
      });
      if (result.ok) {
        recorded += 1;
        console.log(`  RECORDED as ${result.data.classification} (reply ${result.data.replyId})`);
      } else {
        console.log(`  FAILED to record: ${result.error.message}`);
      }
    }
  }
  console.log(
    `\n${found} repl${found === 1 ? "y" : "ies"} found` +
      (RECORD ? `, ${recorded} newly recorded` : " (dry run — pass --record to write the ledger)")
  );
}

main().then(() => process.exit(0));
