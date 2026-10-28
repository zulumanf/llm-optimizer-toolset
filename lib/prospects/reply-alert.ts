/**
 * Spec 170: a human reply worth answering fast reaches the operator's own
 * inbox at once. The prospect's reply already lands in the sending mailbox;
 * this alert goes to the prospect owner's account email (where phone
 * notifications live) with the classification, an excerpt and the link.
 * Internal recipient only — never a prospect. A failure never affects
 * recording the reply.
 */
import { sql } from "@/db/client";
import { executeCapability } from "@/lib/connectors/execute";
import { log } from "@/lib/logger";
import { getActiveSenderIdentity } from "@/lib/outreach/sender-identity";
import type { ReplyClassification } from "@/lib/prospects/constants";

/** Classifications that deserve an answer within the hour. */
export const ALERT_REPLY_CLASSIFICATIONS: readonly ReplyClassification[] = [
  "positive_interest",
  "question",
  "proof_request",
  "referral",
];
const REPLY_ALERT_EXCERPT_CHARS = 600;

const LABEL: Partial<Record<ReplyClassification, string>> = {
  positive_interest: "Positive reply",
  question: "Question",
  proof_request: "Proof request",
  referral: "Referral",
};

/** Pure: the alert email, or null when this reply doesn't warrant one. */
export function buildReplyAlert(input: {
  classification: ReplyClassification;
  prospectName: string;
  marketName: string | null;
  bodyText: string;
  prospectUrl: string | null;
}): { subject: string; body: string } | null {
  if (!ALERT_REPLY_CLASSIFICATIONS.includes(input.classification)) return null;
  const label = LABEL[input.classification] ?? "Reply";
  const excerpt = input.bodyText.trim().slice(0, REPLY_ALERT_EXCERPT_CHARS);
  return {
    subject: `[${label}] ${input.prospectName}${input.marketName ? ` (${input.marketName})` : ""}: answer within the hour`,
    body: [
      `${label} from ${input.prospectName}${input.marketName ? ` in ${input.marketName}` : ""}.`,
      ``,
      `They wrote:`,
      excerpt,
      ``,
      input.prospectUrl ? `Prospect: ${input.prospectUrl}` : ``,
      `Reply from the outreach mailbox, in the same thread.`,
    ].join("\n"),
  };
}

export async function alertOperatorOfReply(args: {
  prospectId: string;
  classification: ReplyClassification;
  bodyText: string;
}): Promise<void> {
  try {
    const [p] = await sql`
      select p.business_name, m.name as market_name, u.email as owner_email
      from prospects p
      left join market_launches l on l.id = p.launch_id
      left join markets m on m.id = l.market_id
      left join users u on u.id = p.owner_id and u.active
      where p.id = ${args.prospectId}`;
    if (!p) return;
    const base = process.env.APP_URL?.replace(/\/$/, "") ?? null;
    const alert = buildReplyAlert({
      classification: args.classification,
      prospectName: p.businessName as string,
      marketName: (p.marketName as string | null) ?? null,
      bodyText: args.bodyText,
      prospectUrl: base ? `${base}/prospects/${args.prospectId}` : null,
    });
    if (!alert) return;
    const to = (p.ownerEmail as string | null) ?? (await getActiveSenderIdentity())?.replyToEmail ?? null;
    if (!to) {
      log("warn", "reply_alert.no_recipient", { prospectId: args.prospectId });
      return;
    }
    const res = await executeCapability({
      capability: "email.send_approved_message",
      projectId: null,
      provider: "gmail",
      mode: "live",
      input: { to, subject: alert.subject, body: alert.body },
    });
    log(res.ok ? "info" : "warn", "reply_alert.sent", { prospectId: args.prospectId, ok: res.ok, error: res.ok ? null : res.error });
  } catch (err) {
    log("warn", "reply_alert.failed", { prospectId: args.prospectId, error: err instanceof Error ? err.message : String(err) });
  }
}
