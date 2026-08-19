/**
 * Prospect outreach channels (spec 043). A channel is a dispatch mechanism
 * behind a human click — never an autonomous sender (DECISIONS.md, spec-011
 * reconciliation): first-touch prospect outreach is human-dispatched, and
 * the gate chain in sendProspectDraft runs before any channel is reached.
 *
 * 'manual' records a send the human made from their own mailbox — no
 * external call, but the full gate ledger applies, which is the whole point
 * of the bridge. 'mock' exists for CI and is refused in production by the
 * same guard as every other mock. A real ESP/Gmail channel is appended here
 * after live verification (roadmap 3.2), credentials before code never.
 */
import { ClassifiedError } from "@/lib/errors";
import { mockProviderAllowed } from "@/lib/ai/registry";
import { executeCapability } from "@/lib/connectors/execute";

export interface OutboundEmail {
  recipientEmail: string | null;
  subject: string | null;
  body: string;
}

export interface EmailChannel {
  readonly id: string;
  /** True when the channel actually transmits (and thus needs a recipient
   * address and an opt-out path in the body). */
  readonly transmits: boolean;
  dispatch(message: OutboundEmail): Promise<{ providerMessageId: string | null }>;
}

const manualChannel: EmailChannel = {
  id: "manual",
  transmits: false,
  async dispatch() {
    // The human already sent it from their own mailbox; the ledger row and
    // gate verdict are what this dispatch exists to produce.
    return { providerMessageId: null };
  },
};

const mockChannel: EmailChannel = {
  id: "mock",
  transmits: true,
  async dispatch(message: OutboundEmail) {
    if (!message.recipientEmail) {
      throw new ClassifiedError("validation", "The mock channel requires a recipient email.");
    }
    return { providerMessageId: `mock-${message.recipientEmail}` };
  },
};

/**
 * The first real transmitting channel (spec 091). Deliberately dumb: every
 * gate (approval, DNC, suppression, recontact, territory, sender identity,
 * daily cap) runs in sendProspectDraft before dispatch is reached, and the
 * connector layer owns credentials, refresh, and the Gmail API shape.
 * Prospect outreach is platform-scoped, so the connection is the
 * platform-level (project_id null) gmail connection minted by
 * scripts/connect-gmail.ts.
 */
const gmailChannel: EmailChannel = {
  id: "gmail",
  transmits: true,
  async dispatch(message: OutboundEmail) {
    if (!message.recipientEmail) {
      throw new ClassifiedError("validation", "The gmail channel requires a recipient email.");
    }
    if (!message.subject || message.subject.trim().length === 0) {
      throw new ClassifiedError("validation", "The gmail channel requires a subject line.");
    }
    const result = await executeCapability<{ messageId: string }>({
      capability: "email.send_approved_message",
      projectId: null,
      input: {
        to: message.recipientEmail,
        subject: message.subject,
        body: message.body,
      },
      mode: "live",
      provider: "gmail",
    });
    if (!result.ok) {
      if (result.errorCode === "no_connection") {
        throw new ClassifiedError(
          "validation",
          "No Gmail connection is configured — run scripts/connect-gmail.ts to authorize the sending mailbox."
        );
      }
      if (result.errorCode === "revoked") {
        throw new ClassifiedError(
          "provider_auth",
          "The Gmail connection has been revoked — re-run scripts/connect-gmail.ts to re-authorize."
        );
      }
      // Transport-level failure: nothing was accepted by Gmail (the HTTP
      // call failed or returned an error), so retrying is safe.
      throw new ClassifiedError(
        "internal",
        `Gmail dispatch failed (${result.errorCode ?? "unknown"}): ${result.error ?? "no detail"}`
      );
    }
    // A successful dispatch MUST be recorded even if Gmail's response
    // carried no id — throwing here would roll back the ledger row for a
    // message that actually left. Null id = "sent, id not returned".
    const messageId = result.data?.messageId;
    return { providerMessageId: messageId && messageId.length > 0 ? messageId : null };
  },
};

const CHANNELS: Record<string, EmailChannel> = {
  manual: manualChannel,
  mock: mockChannel,
  gmail: gmailChannel,
};

export const OUTREACH_SEND_CHANNELS = Object.keys(CHANNELS);

export function getEmailChannel(id: string): EmailChannel {
  const channel = CHANNELS[id];
  if (!channel) {
    throw new ClassifiedError("not_found", `Unknown outreach channel "${id}".`);
  }
  if (id === "mock" && !mockProviderAllowed()) {
    throw new ClassifiedError(
      "validation",
      "The mock outreach channel is disabled outside tests. Verify a real email channel, or set ALLOW_MOCK_PROVIDER=1 in a development environment that explicitly wants pretend sends."
    );
  }
  return channel;
}

/**
 * Appended to every transmitting dispatch AND to system-generated draft
 * bodies (so manual sends copied from a draft are compliant too). Built
 * from the configured sender identity: truthful sender, company, and the
 * physical postal address CAN-SPAM §7704(a)(5) requires — the old footer
 * carried only a user name (spec 052). Reply-based opt-out is the
 * functioning return path; opt-out replies land on the suppression list.
 */
export function optOutFooter(identity: {
  senderName: string;
  companyName: string;
  postalAddress: string;
}): string {
  return (
    `\n\n—\n${identity.senderName} · ${identity.companyName}\n` +
    `${identity.postalAddress}\n` +
    `If you'd rather not hear from us, reply "unsubscribe" and we will not contact you again.`
  );
}

/** The gate asserts an opt-out mention exists before a transmitting send. */
export function hasOptOutMention(body: string): boolean {
  return /unsubscribe|opt[ -]?out/i.test(body);
}
