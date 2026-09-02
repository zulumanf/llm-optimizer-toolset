/**
 * Cohort-124 gap enrichment via the EXISTING Perplexity layer (spec 079),
 * with deterministic on-page verification (2026-08-31):
 *
 *   gap candidate → enrichProspect (Perplexity, cached-fresh aware) →
 *   contact_email proposals → curl the cited source page and require the
 *   LITERAL email string on-page → verified rows recorded as primary
 *   contact (publicly_sourced, source URL in notes); everything else stays
 *   DISCOVERED_UNVERIFIED and is never sent.
 *
 * Perplexity is discovery, not verification — the fetch check is the
 * verification. Nothing sends.
 *
 * Run: npx tsx scripts/cohort124-gap-enrich.ts [--limit 20]
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { enrichProspect } from "@/lib/prospects/enrichment";
import { addContact, updateProspect } from "@/lib/prospects/service";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function operatorUser(): Promise<CurrentUser> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("Operator user not found.");
  return { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
}

/** Fetch a page and report whether the literal email appears (plain or
 * Cloudflare-encoded — cfemail decode is deterministic XOR). */
function emailOnPage(url: string, email: string): boolean {
  let html = "";
  try {
    html = execFileSync(
      "curl",
      ["-sL", "--max-time", "20", "-A", UA, url],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }
    );
  } catch {
    return false;
  }
  const target = email.toLowerCase();
  if (html.toLowerCase().includes(target)) return true;
  // Cloudflare-obfuscated mailtos: data-cfemail="<hex>" — first byte is the
  // XOR key over the remaining bytes.
  for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) {
    const hex = m[1]!;
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    const key = bytes[0]!;
    const decoded = bytes.slice(1).map((b) => String.fromCharCode(b ^ key)).join("");
    if (decoded.toLowerCase() === target) return true;
  }
  return false;
}

async function main(): Promise<void> {
  const user = await operatorUser();
  const limitIdx = process.argv.indexOf("--limit");
  const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : 20;
  const gaps = JSON.parse(
    readFileSync(".local-data/prospecting/cohort124/gap-candidates.json", "utf8")
  ) as { prospectId: string; business: string; teamLeader: string | null }[];

  let attempted = 0;
  let discovered = 0;
  let verified = 0;
  for (const g of gaps.slice(0, limit)) {
    attempted += 1;
    const res = await enrichProspect(user, { prospectId: g.prospectId, force: false });
    if (!res.ok) {
      console.log(`${g.business}: enrich FAILED — ${res.error.message}`);
      continue;
    }
    const proposals = await sql`
      select id, payload, citations from enrichment_proposals
      where prospect_id = ${g.prospectId} and kind = 'contact_email' and status = 'pending'
      order by created_at desc limit 3`;
    let done = false;
    for (const p of proposals) {
      const payload = p.payload as Record<string, unknown>;
      const email = (payload.email as string | null)?.trim();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) continue;
      discovered += 1;
      const sources = [
        payload.sourceUrl as string | null,
        ...((p.citations as string[]) ?? []),
      ].filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
      const proof = sources.find((u) => emailOnPage(u, email));
      if (!proof) {
        console.log(`${g.business}: DISCOVERED_UNVERIFIED ${email} (no source page shows it)`);
        continue;
      }
      const name =
        (payload.emailContactName as string | null) ?? g.teamLeader ?? g.business;
      const added = await addContact(user, {
        prospectId: g.prospectId,
        name,
        email,
        isPrimary: true,
        provenance: "publicly_sourced",
        notes: `email source (Perplexity-discovered, fetch-verified on page): ${proof}`,
      });
      if (!added.ok) {
        console.log(`${g.business}: addContact FAILED — ${added.error.message}`);
        continue;
      }
      await updateProspect(user, {
        prospectId: g.prospectId,
        email,
        fieldProvenance: { email: "publicly_sourced" },
      });
      verified += 1;
      done = true;
      console.log(`${g.business}: VERIFIED ${email} ← ${proof}`);
      break;
    }
    if (!done && proposals.length === 0) console.log(`${g.business}: no contact proposals`);
  }
  console.log(`\nattempted ${attempted}, discovered ${discovered}, verified ${verified}`);
  await sql.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
