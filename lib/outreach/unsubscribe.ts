/**
 * One-click unsubscribe (spec 157, RFC 8058).
 *
 * A token is issued per allowed Gmail send and stored insert-only. Redeeming
 * it adds a GLOBAL email suppression through the same `suppress()` path the
 * reply classifier uses (spec 124), so every later send to that address —
 * follow-ups included — is refused by the existing `suppression` gate check.
 */
import { randomBytes } from "node:crypto";
import { sql } from "@/db/client";
import { log } from "@/lib/logger";
import { normalizeEmailForMatching } from "@/lib/connectors/mapping";
import { suppress } from "@/lib/outreach/suppression";
import { unsubscribeEndpointUrl } from "@/lib/prospects/urls";

export const UNSUBSCRIBE_TOKEN_SHAPE = /^[0-9a-f]{32}$/;
export const UNSUBSCRIBE_SUPPRESSION_DETAIL = "One-click unsubscribe (spec 157).";

/**
 * Issue a token for one outgoing message. Written on the shared pool, NOT in
 * the caller's send transaction: the token must outlive a ledger rollback
 * because the message carrying it may already have been delivered.
 * Returns null when APP_URL is not configured (no working link can exist).
 */
export async function issueUnsubscribeLink(args: {
  recipientEmail: string;
  prospectId: string | null;
  draftId: string | null;
}): Promise<{ token: string; url: string } | null> {
  const token = randomBytes(16).toString("hex");
  const url = unsubscribeEndpointUrl(token);
  if (!url) return null;
  await sql`
    insert into outreach_unsubscribe_tokens (token, recipient_email, prospect_id, draft_id)
    values (${token}, ${normalizeEmailForMatching(args.recipientEmail)}, ${args.prospectId}, ${args.draftId})
  `;
  return { token, url };
}

export type RedeemOutcome = "suppressed" | "already_suppressed" | "unknown_token";

/**
 * Redeem a token. Never throws for a bad token; callers must answer every
 * outcome identically (no validity oracle). Idempotent.
 */
export async function redeemUnsubscribeToken(token: string, via: "one_click" | "page"): Promise<RedeemOutcome> {
  if (!UNSUBSCRIBE_TOKEN_SHAPE.test(token)) return "unknown_token";
  const [row] = await sql`
    select recipient_email, prospect_id from outreach_unsubscribe_tokens where token = ${token}
  `;
  if (!row) return "unknown_token";
  const result = await sql.begin((tx) =>
    suppress(tx, {
      scope: "email",
      value: row.recipientEmail as string,
      reason: "opt_out",
      detail: UNSUBSCRIBE_SUPPRESSION_DETAIL,
      projectId: null,
      userId: null,
    })
  );
  log("info", "outreach.unsubscribe_redeemed", {
    via,
    prospectId: (row.prospectId as string | null) ?? null,
    alreadySuppressed: result.alreadySuppressed,
  });
  return result.alreadySuppressed ? "already_suppressed" : "suppressed";
}
