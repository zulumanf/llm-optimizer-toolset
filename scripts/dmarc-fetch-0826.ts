/**
 * One-off (2026-08-26): download the DMARC aggregate report attachments
 * (Google + Yahoo) from the inbox and save them to the scratchpad for parsing.
 */
import "dotenv/config";
import { writeFileSync, mkdirSync } from "fs";
import { sql } from "@/db/client";
import { resolveSecrets } from "@/lib/connectors/credentials";

const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";
const OUT =
  "/private/tmp/claude-501/-Users-franciscozuluaga-projects-llm-optimizer-toolset/05a5a4e2-5c13-478e-bd64-1f96c0936d7c/scratchpad/dmarc";

type Part = {
  mimeType?: string;
  filename?: string;
  body?: { data?: string; attachmentId?: string };
  parts?: Part[];
};

function walk(part: Part | undefined, out: Part[]): void {
  if (!part) return;
  if (part.filename && part.body?.attachmentId) out.push(part);
  for (const p of part.parts ?? []) walk(p, out);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const conns = (await sql`
    select id, config from connector_connections
    where provider = 'gmail' and project_id is null
    limit 1
  `) as { id: string; config: { clientId?: string; clientSecret?: string } }[];
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
  }
  const auth = { Authorization: `Bearer ${token}` };

  const res = await fetch(
    `${GMAIL}/messages?q=${encodeURIComponent("subject:(Report Domain) newer_than:3d")}&maxResults=10`,
    { headers: auth }
  );
  const list = (await res.json()) as { messages?: { id: string }[] };
  for (const { id } of list.messages ?? []) {
    const mr = await fetch(`${GMAIL}/messages/${id}?format=full`, { headers: auth });
    const m = (await mr.json()) as { payload?: Part };
    const atts: Part[] = [];
    walk(m.payload, atts);
    for (const a of atts) {
      const ar = await fetch(`${GMAIL}/messages/${id}/attachments/${a.body!.attachmentId}`, {
        headers: auth,
      });
      const aj = (await ar.json()) as { data?: string };
      if (!aj.data) continue;
      const buf = Buffer.from(aj.data.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      const path = `${OUT}/${a.filename}`;
      writeFileSync(path, buf);
      console.log(`saved ${path} (${buf.length} bytes, ${a.mimeType})`);
    }
  }
}

main().then(() => process.exit(0));
