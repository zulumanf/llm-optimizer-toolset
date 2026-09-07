/** Review pass: list pending candidates with duplicate + brokerage-cap context; --apply approves the eligible (non-dup, cap headroom, team/agent). */
import "dotenv/config";
import { sql } from "@/db/client";
import { listDiscoveryCandidates, reviewDiscoveryCandidate } from "@/lib/prospects/discovery";
import type { CurrentUser } from "@/lib/auth";
const APPLY = process.argv.includes("--apply");
const norm = (s: string) => s.toLowerCase().replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
const BROKERAGE = /^(the\s+)?(compass|keller williams|re\/?max|coldwell banker|century ?21|sotheby|berkshire|exp realty|better homes|long (&|and) foster|scott realty|lighthouse realty|seaport real estate|six bricks|agentowned)/i;
async function main(): Promise<void> {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  const user = u as unknown as CurrentUser;
  const existing = await sql`select p.business_name, p.launch_id from prospects p where p.archived_at is null`;
  const byLaunch = new Map<string, Set<string>>();
  for (const e of existing) {
    const s = byLaunch.get(e.launchId as string) ?? new Set();
    s.add(norm(e.businessName as string)); byLaunch.set(e.launchId as string, s);
  }
  // brokerage usage (sent or scheduled, 30d) per launch — cap 3
  const used = await sql`select p.launch_id, lower(coalesce(p.brokerage_affiliation,'')) b, count(*)::int n from prospects p
    where exists (select 1 from prospect_outreach_sends s where s.prospect_id=p.id and s.allowed and s.sent_at>now()-interval '30 days')
       or exists (select 1 from outreach_drafts d where d.prospect_id=p.id and d.status='approved' and d.scheduled_send_at>now())
    group by 1,2`;
  const brokUsed = new Map(used.map((r) => [`${r.launchId}|${r.b}`, Number(r.n)]));
  const cands = await listDiscoveryCandidates({ status: "pending" });
  let approved = 0;
  const perLaunchApproved = new Map<string, number>();
  for (const c of cands) {
    const cn = norm(c.businessName);
    const dup = [...(byLaunch.get(c.launchId) ?? [])].some((e) => e === cn || e.includes(cn) || cn.includes(e));
    const isBrokerage = BROKERAGE.test(c.businessName);
    const brokKey = `${c.launchId}|${(c.payload.brokerageAffiliation ?? "").toLowerCase()}`;
    const bu = brokUsed.get(brokKey) ?? 0;
    const capped = bu >= 3;
    const nApproved = perLaunchApproved.get(c.launchId) ?? 0;
    const ok = !dup && !capped && !isBrokerage && nApproved < 8;
    console.log(`${ok ? "APPROVE" : dup ? "skip-dup" : capped ? "skip-cap" : isBrokerage ? "skip-brokerage" : "skip-limit"} | ${c.launchName} | ${c.businessName} | ${c.payload.brokerageAffiliation ?? "?"} | conf=${c.confidence}`);
    if (!ok || !APPLY) { if (ok) approved++, perLaunchApproved.set(c.launchId, nApproved + 1); continue; }
    const r = await reviewDiscoveryCandidate(user, { candidateId: c.id, decision: "approve" });
    if (r.ok) { approved++; perLaunchApproved.set(c.launchId, nApproved + 1); }
    else console.log(`  FAIL: ${r.error.message}`);
  }
  console.log(`${approved} ${APPLY ? "approved" : "approvable"} of ${cands.length} pending`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
