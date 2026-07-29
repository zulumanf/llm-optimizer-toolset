/**
 * The single inbound webhook endpoint.
 *
 * Everything the outside world pushes at this platform arrives here, is verified,
 * deduplicated, and turned into a **domain event**. It never starts a workflow
 * directly — a subscription decides that. One path in means the tenant and
 * autonomy checks on that path can actually be trusted.
 *
 * The raw body is read as text before any parsing, because an HMAC over a
 * re-serialised object is not an HMAC over what the provider signed.
 */
import { NextResponse } from "next/server";
import { receiveWebhook, type WebhookRequest } from "@/lib/triggers/webhook";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * Signature and event-id headers differ per provider. Rather than a per-provider
 * route, the known header names are checked in order — the endpoint's configured
 * `signature_scheme` decides how the value is verified.
 */
const SIGNATURE_HEADERS = [
  "stripe-signature",
  "x-hub-signature-256",
  "x-signature",
  "x-webhook-signature",
  "x-hubspot-signature-v3",
];

const EVENT_ID_HEADERS = [
  "x-event-id",
  "x-request-id",
  "x-webhook-id",
  "idempotency-key",
  "x-hubspot-request-timestamp",
];

/** Stripe packs `t=` and `v1=` into one header; pull the parts out. */
function parseStripeSignature(value: string): { timestamp: number | null; signature: string | null } {
  let timestamp: number | null = null;
  let signature: string | null = null;
  for (const part of value.split(",")) {
    const [key, raw] = part.split("=");
    if (key?.trim() === "t" && raw) {
      const parsed = Number(raw.trim());
      if (Number.isFinite(parsed)) timestamp = parsed;
    }
    if (key?.trim() === "v1" && raw) signature = raw.trim();
  }
  return { timestamp, signature };
}

export async function POST(
  request: Request,
  context: { params: Promise<{ slug: string }> }
): Promise<NextResponse> {
  const { slug } = await context.params;

  // Read the raw body first and only once. Re-serialising would invalidate the
  // signature over the exact bytes the provider signed.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "Could not read the request body" }, { status: 400 });
  }
  if (rawBody.length > 1_000_000) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let signature: string | null = null;
  let timestamp: number | null = null;
  const stripeHeader = request.headers.get("stripe-signature");
  if (stripeHeader) {
    const parsed = parseStripeSignature(stripeHeader);
    signature = parsed.signature;
    timestamp = parsed.timestamp;
  } else {
    for (const name of SIGNATURE_HEADERS) {
      const value = request.headers.get(name);
      if (value) {
        // GitHub-style headers prefix the algorithm; the raw digest is what we compare.
        signature = value.startsWith("sha256=") ? value.slice("sha256=".length) : value;
        break;
      }
    }
    const timestampHeader =
      request.headers.get("x-webhook-timestamp") ?? request.headers.get("x-timestamp");
    if (timestampHeader && Number.isFinite(Number(timestampHeader))) {
      timestamp = Number(timestampHeader);
    }
  }

  let providerEventId: string | null = null;
  for (const name of EVENT_ID_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      providerEventId = value;
      break;
    }
  }

  const webhookRequest: WebhookRequest = {
    slug,
    rawBody,
    signature,
    timestamp,
    providerEventId,
  };

  try {
    const result = await receiveWebhook(webhookRequest);
    log(result.httpStatus >= 400 ? "warn" : "info", "webhook.handled", {
      slug,
      status: result.status,
      httpStatus: result.httpStatus,
    });
    return NextResponse.json(
      {
        status: result.status,
        message: result.message,
        ...(result.eventId ? { eventId: result.eventId } : {}),
      },
      { status: result.httpStatus }
    );
  } catch (err) {
    // Never echo an internal error to an unauthenticated caller.
    log("error", "webhook.handler_failed", {
      slug,
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "Webhook processing failed" }, { status: 500 });
  }
}

/** A GET is a liveness probe only — it never reveals whether a slug exists. */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ok: true, message: "Webhook endpoint. POST signed payloads here." });
}
