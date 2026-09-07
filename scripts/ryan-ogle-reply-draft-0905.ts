/**
 * 2026-09-05 one-off (spec 130): stage the founder's reply to Ryan Ogle as
 * an UNAPPROVED draft threaded under his reply (reply_to_id), carrying the
 * corrected evidence snapshot. Status stays 'draft' — the dispatcher only
 * transmits approved drafts — and the deterministic QA must fail while
 * [FOUNDER_PRICING] remains. Nothing is sent.
 *
 * Run: npx tsx scripts/ryan-ogle-reply-draft-0905.ts <body-file> [--apply]
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { sql } from "@/db/client";
import { qaDraft } from "@/lib/prospects/draft-qa";
import { deliveredTouch1 } from "@/lib/prospects/followups";

const APPLY = process.argv.includes("--apply");
const file = process.argv[2]!;
const PROSPECT = "ba4860d6-3118-4a42-8af1-7bedbb2e27a0";
const T1_DRAFT = "ab905c18-9a1b-42bd-be0b-a2128a8bf4d6";
const REPLY = "6c30b27c-d4ce-4df2-b15c-f11c924db7f2"; // original ingested row: carries the Gmail id for threading
const USER = "2a01d915-35ad-40bb-94cc-78a86d3619ba";
const SUBJECT = "Re: Ryan - Grand Rapids";

async function main(): Promise<void> {
  const body = readFileSync(file, "utf8").trimEnd();
  const t1 = await deliveredTouch1(PROSPECT);
  if (!t1?.correction) throw new Error("expected a corrected Touch 1");
  const [existing] = await sql`select id, status from outreach_drafts where prospect_id = ${PROSPECT} and reply_to_id = ${REPLY} and status = 'draft' order by created_at desc limit 1`;
  let id = existing?.id as string | undefined;
  if (!APPLY) { console.log(`dry run · existing draft: ${id ?? "none"} · body ${body.split(/\s+/).length} words`); await sql.end(); return; }
  if (id) {
    await sql`update outreach_drafts set body = ${body}, subject = ${SUBJECT}, evidence_snapshot = ${sql.json(t1.evidenceSnapshot as never)} where id = ${id} and status = 'draft'`;
    console.log(`updated draft ${id}`);
  } else {
    const [row] = await sql`
      insert into outreach_drafts
        (prospect_id, finding_id, channel, contact_id, version, subject, body, tone, cta, generated_by, prompt_version,
         evidence_snapshot, status, created_by, reply_to_id)
      select d.prospect_id, d.finding_id, d.channel, d.contact_id,
        (select coalesce(max(version), 0) + 1 from outreach_drafts where prospect_id = ${PROSPECT}),
        ${SUBJECT}, ${body}, 'direct, plain, transparent', 'Pricing stated; report linked; no call ask', 'operator', null,
        ${sql.json(t1.evidenceSnapshot as never)}, 'draft', ${USER}, ${REPLY}
      from outreach_drafts d where d.id = ${T1_DRAFT}
      returning id`;
    id = row!.id as string;
    console.log(`inserted draft ${id} (status draft, reply_to ${REPLY.slice(0, 8)})`);
  }
  const issues = await qaDraft(id!);
  console.log(`DRAFT QA: ${issues.length ? "FAIL (expected while the placeholder remains)" : "pass"}`);
  for (const i of issues) console.log(`  [${i.check}] ${i.detail}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
