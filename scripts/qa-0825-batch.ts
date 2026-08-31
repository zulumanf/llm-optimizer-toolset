/**
 * Systematic QA of the 2026-08-25 send batch (25 emails + their audits).
 * Prints FAILURES ONLY per check, then a subjects/recipients table.
 * Checks per draft: contact binding, greeting matches contact/team leader,
 * subject sanity, footer (postal + unsubscribe), prohibited phrases, no
 * template artifacts, audit URL == the prospect's branded link, cited
 * counts present in body == published snapshot counts, audit published +
 * unexpired + preparedBy = sender identity + headline == primary finding.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "@/db/client";
import { findProhibitedPhrase } from "@/lib/prospects/constants";

const URL_RE = /https:\/\/app\.recommendedfirst\.com\/audit\/[^\s")]+/;
const FOLLOWUP_JSON = JSON.parse(readFileSync("scripts/jc-followup-drafts.json", "utf8")) as
  { prospectIdPrefix: string; business: string; subject: string; body: string }[];
const B2_NAMES = ["The Pinto Group", "Ellason Curdgele", "Farah Alli", "Trompeter Real Estate"];

interface Row {
  wave: string; business: string; teamLeader: string | null;
  subject: string | null; body: string; cname: string | null; cemail: string | null;
  slug: string | null; lkey: string | null;
  headline: string | null; kfTitle: string | null; kfSample: string | null;
  preparedEmail: string | null; expiresAt: Date | null; primaryTitle: string | null;
}

async function batch(wave: string, where: ReturnType<typeof sql>): Promise<Row[]> {
  const rows = await sql`
    select p.business_name as business, p.team_leader,
      d.subject, d.body, c.name as cname, c.email as cemail,
      al.slug, al.key as lkey,
      a.headline, a.snapshot->'keyFinding'->>'title' as kf_title,
      a.snapshot->'keyFinding'->'metrics'->>'sampleSize' as kf_sample,
      a.snapshot->'preparedBy'->>'email' as prepared_email, a.expires_at,
      (select f.title from prospect_findings f where f.prospect_id = p.id and f.is_primary and f.status = 'approved') as primary_title
    from outreach_drafts d
    join prospects p on p.id = d.prospect_id
    left join prospect_contacts c on c.id = d.contact_id
    left join prospect_audit_links al on al.prospect_id = p.id
    left join prospect_audits a on a.prospect_id = p.id and a.status = 'published'
    where d.status = 'approved' and d.sent_recorded_at is null and d.scheduled_send_at is null
      and ${where}
    order by p.business_name`;
  return rows.map((r) => ({ wave, ...r }) as unknown as Row);
}

async function main(): Promise<void> {
  const wil = await batch("WIL", sql`p.launch_id::text like 'c0bd8d88%' and p.business_name not in ('The Oldfather Group','The Mottola Group','Robert Blackhurst','Rose Bloom')`);
  const fu = await batch("FU", sql`d.channel = 'followup_email' and p.id::text similar to '(cad98977|e75125e4|ef52c784|9637e5a1|3d29fc25|aee06c80|e7646d81)%'`);
  const b2 = await batch("B2", sql`d.channel = 'email' and p.business_name = any(${B2_NAMES})`);
  const all = [...wil, ...fu, ...b2];
  const issues: string[] = [];
  const flag = (r: Row, what: string): void => { issues.push(`[${r.wave}] ${r.business}: ${what}`); };

  for (const r of all) {
    const body = r.body ?? "";
    // contact + greeting
    if (!r.cemail) flag(r, "NO contact email bound");
    const greet = body.match(/^Hi ([^,]+),/)?.[1];
    if (!greet) flag(r, "no greeting");
    else if (greet !== "there") {
      const pool = `${r.cname ?? ""} ${r.teamLeader ?? ""}`.toLowerCase();
      if (!pool.includes(greet.toLowerCase())) flag(r, `greeting "${greet}" not in contact/leader names (${r.cname} / ${r.teamLeader})`);
    }
    // subject
    if (!r.subject || r.subject.length < 10 || r.subject.length > 90) flag(r, `subject length ${r.subject?.length}`);
    if (/null|undefined|\{\{/.test(r.subject ?? "")) flag(r, `subject artifact: ${r.subject}`);
    // body artifacts + compliance
    if (/\bnull\b|undefined|\{\{|\[object/.test(body)) flag(r, "body artifact (null/undefined/template)");
    if (!body.includes("1399 Myrtle Ave")) flag(r, "missing postal footer");
    if (!body.toLowerCase().includes("unsubscribe")) flag(r, "missing unsubscribe");
    const bad = findProhibitedPhrase(body) ?? findProhibitedPhrase(r.subject ?? "");
    if (bad) flag(r, `prohibited phrase: ${bad}`);
    // audit link
    const url = body.match(URL_RE)?.[0];
    if (!url) flag(r, "no audit URL in body");
    else if (r.slug && r.lkey && url !== `https://app.recommendedfirst.com/audit/${r.slug}/${r.lkey}`)
      flag(r, `URL mismatch: ${url} vs branded ${r.slug}/${r.lkey}`);
    // audit state
    if (!r.headline) flag(r, "no published audit");
    if (r.preparedEmail !== "francisco@recommendedfirst.com") flag(r, `preparedBy ${r.preparedEmail}`);
    if (r.expiresAt && new Date(r.expiresAt).getTime() < Date.now() + 14 * 86400e3) flag(r, `audit expires soon: ${r.expiresAt}`);
    if (r.kfTitle && r.primaryTitle && r.kfTitle !== r.primaryTitle) flag(r, `snapshot finding != primary: "${r.kfTitle}" vs "${r.primaryTitle}"`);
    // counted-number consistency: sample size cited in body must match snapshot
    if (r.kfSample && !body.includes(String(r.kfSample)) && r.wave !== "FU")
      flag(r, `body does not cite sampleSize ${r.kfSample}`);
    if (r.wave === "FU") {
      const j = FOLLOWUP_JSON.find((x) => x.business === r.business);
      if (!j) flag(r, "no JSON source");
      else { if (body !== j.body) flag(r, "body != reviewed JSON"); if (r.subject !== j.subject) flag(r, "subject != reviewed JSON"); }
    }
  }
  console.log(`drafts checked: WIL=${wil.length} FU=${fu.length} B2=${b2.length} (want 14/7/4)`);
  console.log(issues.length ? issues.join("\n") : "ALL PROGRAMMATIC CHECKS PASS");
  console.log("\n--- SUBJECTS / RECIPIENTS ---");
  for (const r of all) console.log(`[${r.wave}] ${r.cemail} | ${r.subject}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
