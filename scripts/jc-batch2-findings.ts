/**
 * JC batch 2 prep (2026-08-21): bring the unsent JC audits to the v2
 * finding bar the first batch shipped with. Per prospect: regenerate
 * findings on the current primary's benchmark → approve the v2
 * authority_visibility_gap candidate as primary → sense-check → republish
 * (token preserved, expiry carried). Dry-run by default; --apply to do it.
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { generateFindings, reviewFinding } from "@/lib/prospects/service";
import { runSenseCheck } from "@/lib/prospects/sense-check";
import { publishAudit, type AuditSnapshot } from "@/lib/prospects/audits";
import { FINDING_GENERATOR_VERSION } from "@/lib/prospects/constants";

const APPLY = process.argv.includes("--apply");
const ONLY = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const EXCLUDE = new Set(["Team Moza"]);
const ACK_REASON =
  "JC batch 2 prep: primary finding regenerated with prospect-findings-v2 (spec 094 wording) before first outreach; measurement basis unchanged.";

async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("operator user not found");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };

  const rows = await sql`
    select p.id, p.business_name,
      f.id as finding_id, f.benchmark_id, f.generator_version, f.kind as primary_kind,
      a.id as audit_id, a.expires_at, a.snapshot
    from prospects p
    join market_launches l on l.id = p.launch_id
    join prospect_findings f on f.prospect_id = p.id and f.is_primary and f.status = 'approved'
    join prospect_audits a on a.prospect_id = p.id and a.status = 'published'
    where l.name ilike '%jersey%' and p.archived_at is null
      and not exists (select 1 from prospect_outreach_sends s where s.prospect_id = p.id)
    order by p.business_name`;

  for (const r of rows) {
    const name = r.businessName as string;
    if (EXCLUDE.has(name)) continue;
    if (ONLY && !name.toLowerCase().includes(ONLY.toLowerCase())) continue;
    const tag = `${name} (${(r.id as string).slice(0, 8)})`;
    if (r.generatorVersion === FINDING_GENERATOR_VERSION) { console.log(`skip (already v2): ${tag}`); continue; }
    if (!APPLY) { console.log(`would upgrade: ${tag} primary ${r.generatorVersion} on benchmark ${(r.benchmarkId as string).slice(0,8)}`); continue; }

    const gen = await generateFindings(user, { benchmarkId: r.benchmarkId });
    if (!gen.ok) { console.error(`FAILED generate: ${tag} — ${gen.error.message}`); continue; }
    const [cand] = await sql`
      select id, title from prospect_findings
      where prospect_id = ${r.id} and benchmark_id = ${r.benchmarkId}
        and status = 'candidate' and kind = ${r.primaryKind}
        and generator_version = ${FINDING_GENERATOR_VERSION}
      order by created_at desc limit 1`;
    if (!cand) { console.error(`FAILED: ${tag} — no v2 ${r.primaryKind} candidate (${gen.data.candidateCount} candidates)`); continue; }
    const rev = await reviewFinding(user, { findingId: cand.id, decision: "approved", makePrimary: true });
    if (!rev.ok) { console.error(`FAILED approve: ${tag} — ${rev.error.message}`); continue; }
    console.log(`primary → v2: ${tag}: ${cand.title}`);

    const sc = await runSenseCheck(user, { prospectId: r.id });
    if (!sc.ok) console.error(`  sense-check error: ${sc.error.message}`);
    else {
      const concerns = sc.data.concerns.filter((c) => c.severity === "concern");
      console.log(`  sense-check: ${sc.data.error ? "FAILED " + sc.data.error : `${sc.data.concerns.length} item(s), ${concerns.length} concern(s)`}`);
      for (const c of concerns) console.log(`    · [${c.area}] ${c.detail}`);
    }

    const snap = r.snapshot as AuditSnapshot;
    const pub = await publishAudit(user, {
      prospectId: r.id as string,
      ...(r.expiresAt ? { expiresAt: new Date(r.expiresAt as Date).toISOString() } : {}),
      ...(snap.humanFinding ? { humanFinding: snap.humanFinding } : {}),
      ...(snap.adoptionStat ? { adoptionStat: snap.adoptionStat } : {}),
      acknowledgeStale: true,
      acknowledgeWarnings: { reason: ACK_REASON },
    });
    if (!pub.ok) { console.error(`  FAILED publish: ${pub.error.message}`); continue; }
    console.log(`  republished: audit ${pub.data.auditId}, token ${pub.data.replaced ? "preserved" : "NEW!"}${pub.data.warnings.length ? ` — ${pub.data.warnings.length} warning(s)` : ""}`);
    for (const w of pub.data.warnings) console.log(`    · ${w}`);
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
