/**
 * One-off ops check (2026-08-26): read the latest inbox messages in full.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { resolveSecrets } from "@/lib/connectors/credentials";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

function decodeB64Url(s: string): string {
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

type Part = {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
};

function extractText(part: Part | undefined, want: string): string {
  if (!part) return "";
  if (part.mimeType === want && part.body?.data) return decodeB64Url(part.body.data);
  for (const p of part.parts ?? []) {
    const t = extractText(p, want);
    if (t) return t;
  }
  return "";
}

async function main() {
  const all = (await sql`
    select id, provider, project_id, status, created_at, config
    from connector_connections
    where provider = 'gmail'
    order by created_at desc
  `) as {
    id: string;
    provider: string;
    projectId: string | null;
    status: string;
    createdAt: string;
    config: { clientId?: string; clientSecret?: string };
  }[];
  console.log(`gmail connections found: ${all.length}`);
  for (const c of all) {
    console.log(`  id=${c.id} project=${c.projectId} status=${c.status} created=${String(c.createdAt)}`);
  }
  const conns = all;
  if (conns.length === 0) {
    console.log("No platform Gmail connection — cannot read inbox.");
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

  const res = await fetch(`${GMAIL}/messages?q=${encodeURIComponent("in:inbox")}&maxResults=5`, {
    headers: auth,
  });
  if (!res.ok) {
    console.log(`Gmail list failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
    return;
  }
  const list = (await res.json()) as { messages?: { id: string }[] };
  const ids = (list.messages ?? []).map((m) => m.id);
  console.log(`=== ${ids.length} most recent inbox messages ===\n`);

  for (const id of ids) {
    const mr = await fetch(`${GMAIL}/messages/${id}?format=full`, { headers: auth });
    if (!mr.ok) {
      console.log(`fetch ${id} failed (${mr.status})`);
      continue;
    }
    const m = (await mr.json()) as {
      payload?: Part & { headers?: { name: string; value: string }[] };
      snippet?: string;
      internalDate?: string;
    };
    const h = new Map(
      (m.payload?.headers ?? []).map((x) => [x.name.toLowerCase(), x.value])
    );
    console.log("──────────────────────────────────────────────");
    console.log(`Date:    ${h.get("date") ?? ""}`);
    console.log(`From:    ${h.get("from") ?? ""}`);
    console.log(`To:      ${h.get("to") ?? ""}`);
    console.log(`Subject: ${h.get("subject") ?? ""}`);
    const text = extractText(m.payload, "text/plain");
    if (text) {
      console.log(`--- body (text/plain, first 3000 chars) ---`);
      console.log(text.slice(0, 3000));
    } else {
      const html = extractText(m.payload, "text/html");
      if (html) {
        console.log(`--- body (html stripped, first 3000 chars) ---`);
        console.log(
          html
            .replace(/<style[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/&nbsp;/g, " ")
            .replace(/\s+/g, " ")
            .slice(0, 3000)
        );
      } else {
        console.log(`(no body found) snippet: ${m.snippet ?? ""}`);
      }
    }
    console.log();
  }
}

main().then(() => process.exit(0));
