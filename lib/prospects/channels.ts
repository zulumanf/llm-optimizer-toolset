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

const CHANNELS: Record<string, EmailChannel> = {
  manual: manualChannel,
  mock: mockChannel,
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
