/**
 * Thread a human reply under the prospect's own message (spec 128). The
 * recorded reply carries the Gmail message id; Gmail search from the
 * prospect's address yields the thread id and the RFC Message-ID that
 * In-Reply-To / References must cite. Null when it cannot be resolved —
 * the caller refuses rather than starting a new thread.
 */
import { sql } from "@/db/client";
import { executeCapability } from "@/lib/connectors/execute";
import type { ParsedGmailMessage } from "@/lib/connectors/adapters/google";
import { REPLY_SYNC_LOOKBACK_DAYS } from "@/lib/prospects/constants";
import type { FollowupThreading } from "@/lib/prospects/followups";

const RFC_MESSAGE_ID = /^<[^\s<>@]+@[^\s<>@]+>$/;

export async function threadingForReply(replyId: string): Promise<FollowupThreading | null> {
  const [r] = await sql`
    select r.gmail_message_id, coalesce(c.email, p.email) as email
    from prospect_replies r
    join prospects p on p.id = r.prospect_id
    left join prospect_contacts c on c.id = r.contact_id
    where r.id = ${replyId}
  `;
  if (!r?.gmailMessageId || !r.email) return null;
  const res = await executeCapability<{ messages: ParsedGmailMessage[] }>({
    capability: "email.search_messages",
    projectId: null,
    provider: "gmail",
    mode: "live",
    input: { q: `from:${r.email as string} newer_than:${REPLY_SYNC_LOOKBACK_DAYS}d`, maxResults: 20 },
  });
  if (!res.ok) return null;
  const m = res.data?.messages.find((x) => x.id === (r.gmailMessageId as string));
  if (!m?.threadId) return null;
  const mid = m.messageId && RFC_MESSAGE_ID.test(m.messageId) ? m.messageId : null;
  return { threadId: m.threadId, inReplyTo: mid, references: mid };
}
