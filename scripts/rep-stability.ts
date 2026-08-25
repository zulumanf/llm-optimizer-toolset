/**
 * Spec 117 §5 — read-only repetition stability analysis. For a completed
 * 4-rep run: per company + provider, recommendation rate at rep subsets
 * {1}, {1..2}, {1..3} vs all 4. If 3-rep rates track 4-rep tightly, a
 * follow-up spec can justify 3 OpenAI reps (−25% of the dominant cost).
 *   npx tsx scripts/rep-stability.ts <runIdPrefix>
 */
import "dotenv/config";
import { sql } from "@/db/client";

async function main(): Promise<void> {
  const prefix = process.argv[2];
  if (!prefix) throw new Error("usage: rep-stability.ts <runIdPrefix>");
  const [run] = await sql`select id, label from runs where id::text like ${prefix + "%"}`;
  if (!run) throw new Error("run not found");
  const rows = await sql`
    select m.company_id, r.provider, r.repetition,
      count(distinct m.response_id) filter (where m.recommended)::int as rec,
      count(distinct r.id)::int as n
    from responses r
    left join mentions m on m.response_id = r.id and m.mentioned
      and not exists (select 1 from mentions nw where nw.response_id = m.response_id
        and nw.company_id = m.company_id and nw.revision > m.revision)
    where r.run_id = ${run.id} and r.error is null
    group by m.company_id, r.provider, r.repetition`;

  // rec counts per company/provider cumulative by repetition subset.
  const byKey = new Map<string, number[]>(); // key → rec per rep (index rep-1)
  const repsN = new Map<string, number[]>();
  for (const r of rows) {
    if (!r.companyId) continue;
    const key = `${r.companyId}|${r.provider}`;
    const arr = byKey.get(key) ?? [0, 0, 0, 0];
    const nn = repsN.get(key) ?? [0, 0, 0, 0];
    const idx = Number(r.repetition) - 1;
    if (idx < 0 || idx > 3) continue;
    arr[idx] = Number(r.rec);
    nn[idx] = Number(r.n);
    byKey.set(key, arr);
    repsN.set(key, nn);
  }
  const diffs: Record<string, number[]> = { r1: [], r2: [], r3: [] };
  for (const [key, arr] of byKey) {
    const nn = repsN.get(key)!;
    const totalN = nn.reduce((a, b) => a + b, 0);
    if (totalN === 0) continue;
    const full = arr.reduce((a, b) => a + b, 0) / totalN;
    if (full === 0) continue; // absent stays absent at any rep count
    const upto = (k: number): number => {
      const n = nn.slice(0, k).reduce((a, b) => a + b, 0);
      return n === 0 ? 0 : arr.slice(0, k).reduce((a, b) => a + b, 0) / n;
    };
    diffs.r1!.push(Math.abs(upto(1) - full));
    diffs.r2!.push(Math.abs(upto(2) - full));
    diffs.r3!.push(Math.abs(upto(3) - full));
  }
  const stat = (a: number[]): string => {
    if (!a.length) return "n=0";
    const s = [...a].sort((x, y) => x - y);
    const mean = a.reduce((x, y) => x + y, 0) / a.length;
    return `n=${a.length} mean|Δ|=${(mean * 100).toFixed(1)}pp max=${(s[s.length - 1]! * 100).toFixed(1)}pp p90=${(s[Math.floor(s.length * 0.9)]! * 100).toFixed(1)}pp`;
  };
  console.log(`run ${run.label}: recommendation-rate deviation vs full 4 reps (mentioned companies only)`);
  console.log("per provider:");
  console.log(`  1 rep : ${stat(diffs.r1!)}`);
  console.log(`  2 reps: ${stat(diffs.r2!)}`);
  console.log(`  3 reps: ${stat(diffs.r3!)}`);

  // Pooled across providers — the number the audit page actually shows.
  const pooledRec = new Map<string, number[]>();
  const pooledN = new Map<string, number[]>();
  for (const [key, arr] of byKey) {
    const company = key.split("|")[0]!;
    const nn = repsN.get(key)!;
    const pr = pooledRec.get(company) ?? [0, 0, 0, 0];
    const pn = pooledN.get(company) ?? [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      pr[i]! += arr[i]!;
      pn[i]! += nn[i]!;
    }
    pooledRec.set(company, pr);
    pooledN.set(company, pn);
  }
  const pooled: Record<string, number[]> = { r1: [], r2: [], r3: [] };
  for (const [company, arr] of pooledRec) {
    const nn = pooledN.get(company)!;
    const totalN = nn.reduce((a, b) => a + b, 0);
    if (totalN === 0) continue;
    const full = arr.reduce((a, b) => a + b, 0) / totalN;
    if (full === 0) continue;
    const upto = (k: number): number => {
      const n = nn.slice(0, k).reduce((a, b) => a + b, 0);
      return n === 0 ? 0 : arr.slice(0, k).reduce((a, b) => a + b, 0) / n;
    };
    pooled.r1!.push(Math.abs(upto(1) - full));
    pooled.r2!.push(Math.abs(upto(2) - full));
    pooled.r3!.push(Math.abs(upto(3) - full));
  }
  console.log("pooled providers (page-facing rates):");
  console.log(`  1 rep : ${stat(pooled.r1!)}`);
  console.log(`  2 reps: ${stat(pooled.r2!)}`);
  console.log(`  3 reps: ${stat(pooled.r3!)}`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
