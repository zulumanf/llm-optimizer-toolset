/** Perplexity contact research for the 12 contactless audited prospects
 * (operator request 2026-08-26). Bounce-lesson guard: an email is added
 * ONLY if fetching the cited public page confirms the address appears on
 * it (2 of 3 hard bounces were unverified Perplexity emails). Verified →
 * addContact(publicly_sourced, source URL in notes); else reported. */
import "dotenv/config";
import { z } from "zod";
import { sql } from "@/db/client";
import { perplexityResearch } from "@/lib/ai/perplexity";
import { addContact } from "@/lib/prospects/service";
import type { CurrentUser } from "@/lib/auth";

const APPLY = process.argv.includes("--apply");
const schema = z.object({
  email: z.string().nullish(),
  contactName: z.string().nullish(),
  sourceUrl: z.string().nullish(),
  confidence: z.number().min(0).max(1).nullish(),
});

async function verify(url: string, email: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; contact-verify)" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return false;
    const text = (await res.text()).toLowerCase();
    return text.includes(email.toLowerCase());
  } catch { return false; }
}

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = u as unknown as CurrentUser;
  const rows = await sql`
    select p.id, p.business_name, p.brokerage_affiliation, l.name launch
    from prospects p join market_launches l on l.id=p.launch_id
    
    where p.archived_at is null and not p.do_not_contact and p.created_at > now() - interval '6 hours'
      and not exists (select 1 from prospect_outreach_sends s where s.prospect_id=p.id and s.allowed)
      and not exists (select 1 from prospect_contacts c where c.prospect_id=p.id and c.archived_at is null and not c.do_not_contact and c.email is not null)
    order by l.name`;
  const ONLY = new Set<string>();
  console.log(`${rows.length} contactless prospects`);
  for (const r of rows) {
    if (ONLY.size && !ONLY.has(r.businessName as string)) continue;
    const market = (r.launch as string).split("—")[0]!.trim();
    try {
      const res = await perplexityResearch({
        agentVersion: "contact-research-v1",
        system: "You find business contact emails for real-estate teams from public webpages (team sites, brokerage agent pages, Zillow/Realtor profiles, rankings). Report the email exactly as shown on a page you cite with its URL. Never construct or guess an address; if truly none is findable, return email: null.",
        user: `Find the publicly listed contact email for the real-estate team "${r.businessName}"${r.brokerageAffiliation ? ` at ${r.brokerageAffiliation}` : ""} in ${market}. Return the exact page URL where the email is visible.`,
        schema, purpose: "contact_research", model: "sonar-pro",
      });
      const o = res.output;
      if (!o.email || !o.sourceUrl) { console.log(`NONE ${r.businessName}: no published email found`); continue; }
      const ok = await verify(o.sourceUrl, o.email);
      const line = `${r.businessName} [${market}]: ${o.email} src=${o.sourceUrl} conf=${o.confidence}`;
      if (!ok) { console.log(`UNVERIFIED ${line}`); continue; }
      if (!APPLY) { console.log(`VERIFIED ${line}`); continue; }
      const added = await addContact(user, {
        prospectId: r.id, name: o.contactName ?? (r.businessName as string), email: o.email, isPrimary: true,
        provenance: "publicly_sourced",
        notes: `email visible at ${o.sourceUrl} (perplexity-located, page-verified 2026-08-26)`,
      });
      console.log(added.ok ? `ADDED ${line}` : `FAIL ${r.businessName}: ${added.error.message}`);
    } catch (e) { console.log(`ERROR ${r.businessName}: ${(e as Error).message.slice(0, 80)}`); }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
