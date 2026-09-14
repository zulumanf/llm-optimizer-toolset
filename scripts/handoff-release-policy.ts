/**
 * Founder per-handoff release-policy exception (migration 114), audited.
 *   npx tsx scripts/handoff-release-policy.ts --handoff <id> --policy report_only|report_and_video|clear --reason "…" [--as <email>] [--reactivate]
 * --reactivate additionally moves a needs_review handoff back into the lane
 * (the audited reactivateHandoff path; re-enters at autonomy_eligible).
 */
import "dotenv/config";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { RELEASE_POLICIES } from "@/lib/prospects/fulfillment-lane";
import { logActivity } from "@/lib/prospects/shared";

const arg = (k: string): string | undefined => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };

async function main(): Promise<void> {
  const handoffId = arg("--handoff"); const policy = arg("--policy"); const reason = arg("--reason");
  if (!handoffId || !policy || !reason || reason.length < 10) throw new Error("usage: --handoff <id> --policy report_only|report_and_video|clear --reason <≥10 chars> [--as <email>] [--reactivate]");
  if (policy !== "clear" && !(RELEASE_POLICIES as readonly string[]).includes(policy)) throw new Error(`unknown policy ${policy}`);
  const asEmail = arg("--as");
  const [u] = asEmail ? await sql`select id, email, name, role from users where email = ${asEmail}` : await sql`select id, email, name, role from users where role = 'admin' order by created_at limit 1`;
  if (!u) throw new Error("no acting user");
  const user: CurrentUser = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role as CurrentUser["role"] };
  const [h] = await sql`select id, prospect_id, status, release_policy_override from prospect_report_handoffs where id = ${handoffId}`;
  if (!h) throw new Error("handoff not found");
  const value = policy === "clear" ? null : policy;
  await sql.begin(async (tx) => {
    await tx`update prospect_report_handoffs set release_policy_override = ${value}, release_policy_override_reason = ${value ? reason : null},
      release_policy_override_by = ${value ? user.id : null}, release_policy_override_at = ${value ? new Date() : null}, updated_at = now() where id = ${handoffId}`;
    await writeAudit(tx, { userId: user.id, action: "prospect.release_policy_override", entity: "prospect_report_handoff", entityId: handoffId, detail: { from: h.releasePolicyOverride ?? null, to: value, reason } });
    await logActivity(tx, h.prospectId as string, "release_policy_override", { handoffId, policy: value, reason }, user.id);
  });
  console.log(`override ${h.releasePolicyOverride ?? "none"} → ${value ?? "none"} on handoff ${handoffId.slice(0, 8)} (status ${h.status as string})`);
  if (process.argv.includes("--reactivate")) {
    const { reactivateHandoff } = await import("@/lib/prospects/fulfillment-lane");
    await reactivateHandoff(user, handoffId, reason);
    const [after] = await sql`select status from prospect_report_handoffs where id = ${handoffId}`;
    console.log(`reactivated → ${after!.status as string}`);
  }
  await sql.end();
}
main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
