/**
 * Supply engine entity step (2026-09-14): apply spec-130 derived lead
 * aliases (licensed RealTrends relationship → company aliases, audited with
 * provenance) for the given prospects' companies, then report the
 * resulting entity resolution status. Deterministic; a derivation that
 * needs a human stays ENTITY_REVIEW_REQUIRED. Nothing sends.
 *
 * Run: DATABASE_URL=<direct url> npx tsx scripts/supply-verify-entities.ts --prospects <id,...>
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { applyVerifiedAliases, entityResolutionStatuses } from "@/lib/prospects/entity-aliases";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const ids = (arg("--prospects") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (ids.length === 0) throw new Error("--prospects <id,...> is required");
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("Operator user not found.");
  const user = { id: u.id, email: u.email, name: u.name, role: u.role } as CurrentUser;
  for (const id of ids) {
    const [p] = await sql`select business_name, company_id from prospects where id = ${id} and archived_at is null`;
    if (!p?.companyId) { console.log(`${id}: no company link — skipped`); continue; }
    const r = await applyVerifiedAliases(user, p.companyId as string);
    const [status] = await entityResolutionStatuses([{ companyId: p.companyId as string, prospectId: id }]);
    console.log(`${p.businessName as string}: aliases ${r.added.length ? `added ${r.added.join(", ")}` : r.refused ? `REFUSED ${r.refused}` : r.derivation.status} → ${status?.verified ? "VERIFIED" : "unverified"}: ${status?.reason}`);
  }
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
