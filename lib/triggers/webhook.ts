/**
 * Webhook intake.
 *
 * The invariant worth stating: a webhook NEVER starts a workflow directly. It
 * verifies, deduplicates, and publishes a domain event; a subscription decides
 * what runs. That keeps exactly one path from the outside world into execution,
 * which is the only way the autonomy and tenant checks can be trusted.
 *
 * Order of operations is deliberate — rate limit before signature (cheap
 * before expensive), signature before schema (authenticity before content),
 * schema before publication (never write an unvalidated payload).
 */
import { createHmac } from "node:crypto";
import { sql } from "@/db/client";
import * as store from "@/db/triggers";
import { publishEvent } from "@/lib/events/bus";
import { eventDefinition } from "@/lib/events/catalog";
import { open, safeEqual } from "@/lib/security/envelope";
import { raiseException } from "@/lib/workflow/exceptions";
import { writeAudit } from "@/db/audit";
import { log } from "@/lib/logger";
import type { WebhookReceiptStatus } from "@/lib/triggers/types";

/** How far a signed timestamp may be from now before we refuse it. */
export const SIGNATURE_WINDOW_SECONDS = 300;

export interface WebhookRequest {
  slug: string;
  rawBody: string;
  signature: string | null;
  /** Unix seconds from the provider's signature header, when it sends one. */
  timestamp: number | null;
  /** The provider's own event id — the replay key. */
  providerEventId: string | null;
}

export interface WebhookResult {
  status: WebhookReceiptStatus;
  httpStatus: number;
  eventId?: string;
  message: string;
}

/**
 * Verify an HMAC-SHA256 signature. Two schemes are supported because Stripe
 * signs `timestamp.body` rather than the body alone; both end in a
 * constant-time comparison.
 */
export function verifySignature(args: {
  scheme: "hmac_sha256" | "stripe" | "none";
  secret: string | null;
  rawBody: string;
  signature: string | null;
  timestamp: number | null;
  now?: Date;
}): { valid: boolean; reason: string } {
  if (args.scheme === "none") {
    return { valid: true, reason: "scheme is none (unsigned endpoint)" };
  }
  if (!args.secret) return { valid: false, reason: "endpoint has no signing secret configured" };
  if (!args.signature) return { valid: false, reason: "no signature header present" };

  if (args.scheme === "stripe") {
    if (args.timestamp === null) {
      return { valid: false, reason: "stripe scheme requires a signed timestamp" };
    }
    const now = Math.floor((args.now ?? new Date()).getTime() / 1000);
    if (Math.abs(now - args.timestamp) > SIGNATURE_WINDOW_SECONDS) {
      return {
        valid: false,
        reason: `signed timestamp is outside the ±${SIGNATURE_WINDOW_SECONDS}s window`,
      };
    }
    const expected = createHmac("sha256", args.secret)
      .update(`${args.timestamp}.${args.rawBody}`)
      .digest("hex");
    return safeEqual(expected, args.signature)
      ? { valid: true, reason: "stripe signature matched" }
      : { valid: false, reason: "signature mismatch" };
  }

  // Plain HMAC of the body. A timestamp is optional but honoured when present,
  // because a valid signature on a very old body is still a replay.
  if (args.timestamp !== null) {
    const now = Math.floor((args.now ?? new Date()).getTime() / 1000);
    if (Math.abs(now - args.timestamp) > SIGNATURE_WINDOW_SECONDS) {
      return {
        valid: false,
        reason: `signed timestamp is outside the ±${SIGNATURE_WINDOW_SECONDS}s window`,
      };
    }
  }
  const expected = createHmac("sha256", args.secret).update(args.rawBody).digest("hex");
  return safeEqual(expected, args.signature)
    ? { valid: true, reason: "signature matched" }
    : { valid: false, reason: "signature mismatch" };
}

/** Fall back to a content hash when the provider sends no event id. */
function replayKeyFor(request: WebhookRequest): string {
  if (request.providerEventId && request.providerEventId.length > 0) {
    return request.providerEventId.slice(0, 200);
  }
  return createHmac("sha256", "replay-key").update(request.rawBody).digest("hex");
}

export async function receiveWebhook(request: WebhookRequest): Promise<WebhookResult> {
  const endpoint = await store.endpointBySlug(request.slug);
  if (!endpoint) {
    // No receipt row is possible without an endpoint; log and refuse.
    log("warn", "webhook.unknown_endpoint", { slug: request.slug });
    return { status: "rejected_disabled", httpStatus: 404, message: "Unknown webhook endpoint." };
  }
  if (!endpoint.enabled || endpoint.revokedAt !== null) {
    return {
      status: "rejected_disabled",
      httpStatus: 403,
      message: "This webhook endpoint is disabled or revoked.",
    };
  }

  const replayKey = replayKeyFor(request);

  // Rate limit first: the cheapest check, and the one that protects the rest.
  const recent = await store.receiptsInLastMinute(endpoint.id);
  if (recent >= endpoint.rateLimitPerMinute) {
    await sql.begin((tx) =>
      store.recordReceipt(tx, {
        endpointId: endpoint.id,
        providerEventId: `${replayKey}:ratelimited:${Date.now()}`,
        signatureValid: false,
        status: "rejected_rate_limit",
        error: `${recent} requests in the trailing minute exceeds the limit of ${endpoint.rateLimitPerMinute}`,
      })
    );
    return {
      status: "rejected_rate_limit",
      httpStatus: 429,
      message: "Rate limit exceeded for this endpoint.",
    };
  }

  let secret: string | null = null;
  if (endpoint.signatureScheme !== "none") {
    const material = await store.endpointSecretMaterial(endpoint.id);
    if (material) {
      secret = open({ ...material, keyVersion: 1 }, endpoint.id);
    }
  }

  const verdict = verifySignature({
    scheme: endpoint.signatureScheme,
    secret,
    rawBody: request.rawBody,
    signature: request.signature,
    timestamp: request.timestamp,
  });

  if (!verdict.valid) {
    await sql.begin(async (tx) => {
      await store.recordReceipt(tx, {
        endpointId: endpoint.id,
        providerEventId: `${replayKey}:badsig:${Date.now()}`,
        signatureValid: false,
        status: "rejected_signature",
        error: verdict.reason,
      });
      await raiseException(tx, {
        projectId: endpoint.projectId,
        kind: "failed_integration",
        severity: "high",
        summary: `Webhook signature rejected on ${endpoint.slug}: ${verdict.reason}`,
        detail: { provider: endpoint.provider, slug: endpoint.slug },
        recommendedAction:
          "Confirm the provider's signing secret matches, then re-send the event from the provider.",
      });
    });
    log("warn", "webhook.signature_invalid", { slug: endpoint.slug, reason: verdict.reason });
    return {
      status: "rejected_signature",
      httpStatus: 401,
      message: "Signature verification failed.",
    };
  }

  // Replay guard. A duplicate is a success from the provider's perspective —
  // returning an error would make it retry forever.
  const receiptId = await sql.begin((tx) =>
    store.recordReceipt(tx, {
      endpointId: endpoint.id,
      providerEventId: replayKey,
      signatureValid: true,
      status: "accepted",
    })
  );
  if (receiptId === null) {
    return {
      status: "duplicate",
      httpStatus: 200,
      message: "Already processed; ignoring replay.",
    };
  }

  let payload: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(request.rawBody);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("body must be a JSON object");
    }
    payload = parsed as Record<string, unknown>;
  } catch (err) {
    const message = err instanceof Error ? err.message : "invalid JSON";
    await sql.begin(
      (tx) => tx`
        update webhook_receipts set status = 'rejected_schema', error = ${message}
        where id = ${receiptId}
      `
    );
    return { status: "rejected_schema", httpStatus: 400, message: `Malformed body: ${message}` };
  }

  const definition = eventDefinition(endpoint.eventType);
  if (!definition) {
    await sql.begin(
      (tx) => tx`
        update webhook_receipts set status = 'rejected_schema',
          error = ${`endpoint maps to unknown event type ${endpoint.eventType}`}
        where id = ${receiptId}
      `
    );
    return {
      status: "rejected_schema",
      httpStatus: 500,
      message: `Endpoint is configured for unknown event type "${endpoint.eventType}".`,
    };
  }

  try {
    const result = await sql.begin(async (tx) => {
      const published = await publishEvent(tx, {
        type: endpoint.eventType,
        projectId: endpoint.projectId,
        source: "webhook",
        payload,
        metadata: { provider: endpoint.provider, slug: endpoint.slug },
        dedupeKey: `webhook:${endpoint.id}:${replayKey}`,
      });
      await store.attachReceiptEvent(tx, receiptId, published.event.id);
      await writeAudit(tx, {
        userId: null,
        action: "webhook.received",
        entity: "webhook_endpoint",
        entityId: endpoint.id,
        detail: { provider: endpoint.provider, eventType: endpoint.eventType },
      });
      return published;
    });
    return {
      status: "accepted",
      httpStatus: 202,
      eventId: result.event.id,
      message: "Accepted.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "unknown error";
    await sql.begin(
      (tx) => tx`
        update webhook_receipts set status = 'rejected_schema', error = ${message.slice(0, 500)}
        where id = ${receiptId}
      `
    );
    return {
      status: "rejected_schema",
      httpStatus: 400,
      message: `Payload does not match the "${endpoint.eventType}" schema: ${message}`,
    };
  }
}
