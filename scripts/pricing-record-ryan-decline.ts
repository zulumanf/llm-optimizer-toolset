/**
 * Spec 135 — record the founder's reading of Ryan Ogle's 2026-09-07 reply on
 * the historical quote that migration 108 backfilled (founder_monthly_7500_v0,
 * $22,500). Records ONLY the outcome fields (declined; PRICE_TOO_HIGH +
 * PREFERS_DIY; DIY; lost) with the reply's own words as the reason. The quote's
 * price, policy and time are untouched; nothing is sent; Ryan's stage, next
 * action, replies and report stay as they are. Refuses to run twice.
 *
 *   npx tsx scripts/pricing-record-ryan-decline.ts
 */
import "dotenv/config";
import { sql } from "@/db/client";
import type { CurrentUser } from "@/lib/auth";
import { recordQuoteOutcome } from "@/lib/pricing/quotes";

const RYAN = "ba4860d6-3118-4a42-8af1-7bedbb2e27a0";

async function main() {
  const [u] = await sql`select id, email, name, role from users where email = 'zulumanf@gmail.com'`;
  if (!u) throw new Error("founder user not found");
  const user = { id: u.id as string, email: u.email as string, name: u.name as string, role: u.role } as CurrentUser;
  const [q] = await sql`select id, status, pricing_policy_version, total_fee_usd, quoted_at from pricing_quotes where prospect_id = ${RYAN} order by quoted_at asc limit 1`;
  if (!q) throw new Error("no backfilled quote for Ryan — run migration 108 first");
  if (q.status !== "presented") throw new Error(`already recorded: ${q.status}`);
  const [reply] = await sql`select received_at, body_text from prospect_replies where prospect_id = ${RYAN} and body_text ilike '%higher than I am willing to spend%' order by received_at asc limit 1`;
  if (!reply) throw new Error("decline reply not found");
  const r = await recordQuoteOutcome(user, {
    quoteId: q.id as string,
    status: "declined",
    objections: ["PRICE_TOO_HIGH", "PREFERS_DIY"],
    preferredSolution: "DIY",
    outcome: "lost",
    lostReason: "Reply 2026-09-07: price higher than he is willing to spend; plans to learn the subject and work on it internally.",
    responseSummary: String(reply.bodyText).slice(0, 400),
    respondedAt: reply.receivedAt as Date,
  });
  if (!r.ok) throw new Error(r.error.message);
  console.log(`recorded: quote ${String(q.id).slice(0, 8)} ${q.pricingPolicyVersion} $${q.totalFeeUsd} quoted ${String(q.quotedAt)} → declined (PRICE_TOO_HIGH, PREFERS_DIY, DIY, lost)`);
  await sql.end();
}
main().catch(async (e) => { console.error(e); await sql.end(); process.exit(1); });
