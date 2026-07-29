/**
 * Billing (Stripe), CMS (WordPress, Webflow) and notification (Slack) adapters.
 *
 * STATUS: Stripe, WordPress and Slack are `implemented_unverified`; Webflow is
 * `contract_only`. None has been executed against a live provider — no
 * credentials exist in this environment.
 *
 * One rule shows up in every handler here: **the platform computes the numbers
 * and owns the approval; the provider is the effector.** Stripe is told an
 * amount in cents that a deterministic node calculated. WordPress is told to
 * publish a specific post id that a human approved. Neither decides anything.
 */
import { z } from "zod";
import {
  buildAdapter,
  expectOk,
  requireString,
  unverifiableHealth,
  abortWith,
} from "@/lib/connectors/adapters/base";
import { executionFailure, type ConnectorContext } from "@/lib/connectors/types";

// ---------------------------------------------------------------- Stripe

const stripeConfig = z.object({
  currency: z.string().length(3).default("usd"),
  /** Days after issue that an invoice is due. Used only when none is supplied. */
  defaultDueDays: z.number().int().min(0).max(180).default(14),
});

const STRIPE_BASE = "https://api.stripe.com/v1";

function stripeAuth(ctx: ConnectorContext): Record<string, string> {
  return { authorization: `Bearer ${ctx.secret()}` };
}

interface StripeInvoice {
  id?: string;
  status?: string;
  amount_due?: number;
  amount_paid?: number;
  currency?: string;
  due_date?: number;
  hosted_invoice_url?: string;
  customer?: string;
  number?: string;
}

function normalizeInvoice(invoice: StripeInvoice) {
  return {
    externalInvoiceId: invoice.id ?? "",
    number: invoice.number ?? "",
    status: invoice.status ?? "unknown",
    amountDueCents: Number(invoice.amount_due ?? 0),
    amountPaidCents: Number(invoice.amount_paid ?? 0),
    currency: (invoice.currency ?? "usd").toUpperCase(),
    dueDate: invoice.due_date ? new Date(invoice.due_date * 1000).toISOString() : null,
    hostedUrl: invoice.hosted_invoice_url ?? null,
    customerRef: invoice.customer ?? null,
  };
}

export const stripeConnector = buildAdapter({
  id: "stripe",
  provider: "stripe",
  version: "1.0.0",
  category: "billing",
  status: "implemented_unverified",
  configSchema: stripeConfig,
  requiredScopes: [],
  outstandingWork: [
    "Never executed against a live Stripe account.",
    "Tax, proration and multi-currency handling are out of scope.",
    "Only single-line invoices are supported.",
  ],
  handlers: {
    /**
     * The amount arrives already computed, in integer cents, from a
     * deterministic node reading the contract record. This handler never
     * calculates, derives, or rounds a total — and an LLM is nowhere near it.
     */
    "billing.create_invoice": async (input, ctx) => {
      const config = stripeConfig.parse(ctx.config);
      const customerRef = requireString(input, "customerRef", "billing.create_invoice");
      const description = requireString(input, "description", "billing.create_invoice");
      const amountCents = input.amountCents;
      if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
        abortWith(
          executionFailure({
            error:
              "billing.create_invoice requires a positive integer amountCents computed by a deterministic node.",
            errorCode: "invalid_input",
            retryable: false,
          })
        );
      }

      // Line item first, then the invoice — Stripe's own ordering.
      const itemResponse = await ctx.http({
        url: `${STRIPE_BASE}/invoiceitems`,
        method: "POST",
        headers: stripeAuth(ctx),
        form: {
          customer: customerRef,
          amount: String(amountCents),
          currency: config.currency,
          description,
        },
      });
      expectOk(itemResponse, (raw) => ({ data: raw }));

      const dueDays =
        typeof input.dueDays === "number" ? input.dueDays : config.defaultDueDays;
      const invoiceResponse = await ctx.http({
        url: `${STRIPE_BASE}/invoices`,
        method: "POST",
        headers: stripeAuth(ctx),
        form: {
          customer: customerRef,
          collection_method: "send_invoice",
          days_until_due: String(dueDays),
          // Idempotency at the provider, in addition to ours. Two layers,
          // because a duplicate invoice is a client-trust incident.
          ...(typeof input.idempotencyKey === "string"
            ? { "metadata[idempotency_key]": input.idempotencyKey }
            : {}),
          ...(ctx.workflowRunId ? { "metadata[workflow_run_id]": ctx.workflowRunId } : {}),
        },
      });
      const { data } = expectOk(invoiceResponse, (raw) => ({
        data: normalizeInvoice((raw ?? {}) as StripeInvoice),
        rowsWritten: 1,
      }));
      return { data, rowsWritten: 1 };
    },

    "billing.fetch_invoice": async (input, ctx) => {
      const invoiceId = requireString(input, "externalInvoiceId", "billing.fetch_invoice");
      const response = await ctx.http({
        url: `${STRIPE_BASE}/invoices/${encodeURIComponent(invoiceId)}`,
        headers: stripeAuth(ctx),
      });
      const { data } = expectOk(response, (raw) => ({
        data: normalizeInvoice((raw ?? {}) as StripeInvoice),
        rowsRead: 1,
      }));
      return { data, rowsRead: 1 };
    },

    "billing.fetch_payment_status": async (input, ctx) => {
      const invoiceId = requireString(input, "externalInvoiceId", "billing.fetch_payment_status");
      const response = await ctx.http({
        url: `${STRIPE_BASE}/invoices/${encodeURIComponent(invoiceId)}`,
        headers: stripeAuth(ctx),
      });
      const { data } = expectOk(response, (raw) => {
        const invoice = normalizeInvoice((raw ?? {}) as StripeInvoice);
        return {
          data: {
            ...invoice,
            paid: invoice.status === "paid",
            overdue:
              invoice.status !== "paid" &&
              invoice.dueDate !== null &&
              new Date(invoice.dueDate).getTime() < Date.now(),
          },
          rowsRead: 1,
        };
      });
      return { data, rowsRead: 1 };
    },

    "billing.send_reminder": async (input, ctx) => {
      const invoiceId = requireString(input, "externalInvoiceId", "billing.send_reminder");
      const response = await ctx.http({
        url: `${STRIPE_BASE}/invoices/${encodeURIComponent(invoiceId)}/send`,
        method: "POST",
        headers: stripeAuth(ctx),
      });
      const { data } = expectOk(response, (raw) => ({
        data: { ...normalizeInvoice((raw ?? {}) as StripeInvoice), reminderSent: true },
        rowsWritten: 1,
      }));
      return { data, rowsWritten: 1 };
    },
  },
  probe: async (ctx) => {
    const started = Date.now();
    const response = await ctx.http({
      url: `${STRIPE_BASE}/invoices?limit=1`,
      headers: stripeAuth(ctx),
    });
    return {
      authorizationOk: response.status !== 401 && response.status !== 403,
      readOk: response.ok,
      latencyMs: Date.now() - started,
      errorCode: response.ok ? null : `http_${response.status}`,
      errorMessage: response.ok ? null : response.text,
    };
  },
});

// ------------------------------------------------------------- WordPress

const wordpressConfig = z.object({
  siteUrl: z.string().url("WordPress siteUrl must be a URL"),
  username: z.string().min(1, "WordPress username is required"),
  postType: z.string().default("posts"),
});

interface WpPost {
  id?: number;
  link?: string;
  status?: string;
  title?: { rendered?: string; raw?: string };
  content?: { rendered?: string };
  modified_gmt?: string;
}

/** WordPress application passwords use HTTP Basic. */
function wpAuth(ctx: ConnectorContext, username: string): Record<string, string> {
  return {
    authorization: `Basic ${Buffer.from(`${username}:${ctx.secret()}`).toString("base64")}`,
  };
}

function normalizePost(post: WpPost) {
  return {
    externalId: post.id === undefined ? "" : String(post.id),
    url: post.link ?? "",
    status: post.status ?? "unknown",
    title: post.title?.raw ?? post.title?.rendered ?? "",
    modifiedAt: post.modified_gmt ?? null,
  };
}

export const wordpressConnector = buildAdapter({
  id: "wordpress",
  provider: "wordpress",
  version: "1.0.0",
  category: "cms",
  status: "implemented_unverified",
  configSchema: wordpressConfig,
  requiredScopes: [],
  outstandingWork: [
    "Never executed against a live WordPress site.",
    "Media upload and featured images are not implemented.",
    "Assumes the standard REST API at /wp-json/wp/v2 is enabled and reachable.",
  ],
  handlers: {
    "cms.create_draft": async (input, ctx) => {
      const config = wordpressConfig.parse(ctx.config);
      const response = await ctx.http({
        url: `${config.siteUrl.replace(/\/$/, "")}/wp-json/wp/v2/${config.postType}`,
        method: "POST",
        headers: wpAuth(ctx, config.username),
        body: {
          title: requireString(input, "title", "cms.create_draft"),
          content: requireString(input, "content", "cms.create_draft"),
          // Always a draft. Publication is a separate, approval-gated capability.
          status: "draft",
          ...(typeof input.slug === "string" ? { slug: input.slug } : {}),
          ...(typeof input.excerpt === "string" ? { excerpt: input.excerpt } : {}),
        },
      });
      const { data } = expectOk(response, (raw) => ({
        data: normalizePost((raw ?? {}) as WpPost),
        rowsWritten: 1,
      }));
      return { data, rowsWritten: 1 };
    },

    "cms.update_draft": async (input, ctx) => {
      const config = wordpressConfig.parse(ctx.config);
      const externalId = requireString(input, "externalId", "cms.update_draft");
      const patch: Record<string, unknown> = {};
      if (typeof input.title === "string") patch.title = input.title;
      if (typeof input.content === "string") patch.content = input.content;
      if (typeof input.excerpt === "string") patch.excerpt = input.excerpt;
      const response = await ctx.http({
        url: `${config.siteUrl.replace(/\/$/, "")}/wp-json/wp/v2/${config.postType}/${encodeURIComponent(externalId)}`,
        method: "POST",
        headers: wpAuth(ctx, config.username),
        body: patch,
      });
      const { data } = expectOk(response, (raw) => ({
        data: normalizePost((raw ?? {}) as WpPost),
        rowsWritten: 1,
      }));
      return { data, rowsWritten: 1 };
    },

    /**
     * Publication requires the approval id the workflow recorded. The adapter
     * cannot verify an approval itself — that is `assertSendAllowed`'s job —
     * but refusing to publish without one makes an un-approved publish
     * impossible to reach by accident.
     */
    "cms.publish_approved_asset": async (input, ctx) => {
      const config = wordpressConfig.parse(ctx.config);
      const externalId = requireString(input, "externalId", "cms.publish_approved_asset");
      requireString(input, "approvalId", "cms.publish_approved_asset");
      const response = await ctx.http({
        url: `${config.siteUrl.replace(/\/$/, "")}/wp-json/wp/v2/${config.postType}/${encodeURIComponent(externalId)}`,
        method: "POST",
        headers: wpAuth(ctx, config.username),
        body: { status: "publish" },
      });
      const { data } = expectOk(response, (raw) => ({
        data: { ...normalizePost((raw ?? {}) as WpPost), published: true },
        rowsWritten: 1,
      }));
      return { data, rowsWritten: 1 };
    },

    /** Fetch the live page, so "did it actually publish?" is verifiable. */
    "cms.fetch_public_page": async (input, ctx) => {
      const url = requireString(input, "url", "cms.fetch_public_page");
      const response = await ctx.http({ url, method: "GET" });
      return {
        data: {
          url,
          status: response.status,
          reachable: response.ok,
          // Bounded: enough to verify presence of a title or a claim, not a
          // full crawl.
          excerpt: response.text.slice(0, 2000),
        },
        rowsRead: 1,
      };
    },
  },
  probe: async (ctx) => {
    const config = wordpressConfig.parse(ctx.config);
    const started = Date.now();
    const response = await ctx.http({
      url: `${config.siteUrl.replace(/\/$/, "")}/wp-json/wp/v2/users/me`,
      headers: wpAuth(ctx, config.username),
    });
    return {
      authorizationOk: response.status !== 401 && response.status !== 403,
      readOk: response.ok,
      latencyMs: Date.now() - started,
      errorCode: response.ok ? null : `http_${response.status}`,
      errorMessage: response.ok ? null : response.text,
    };
  },
});

// ---------------------------------------------------------------- Webflow

const webflowConfig = z.object({
  siteId: z.string().min(1, "Webflow siteId is required"),
  collectionId: z.string().min(1, "Webflow collectionId is required"),
});

export const webflowConnector = buildAdapter({
  id: "webflow",
  provider: "webflow",
  version: "0.1.0",
  category: "cms",
  status: "contract_only",
  configSchema: webflowConfig,
  requiredScopes: ["cms:read", "cms:write"],
  outstandingWork: [
    "No live request path. Contract, config validation and fixture mode only.",
    "Webflow CMS field slugs are site-specific and need discovery against a real site.",
    "Publishing requires a site-publish call whose semantics differ per plan.",
  ],
  handlers: {
    "cms.create_draft": async () => {
      throw new Error(
        "Webflow adapter is contract_only: no live request path. Use fixture mode, or WordPress."
      );
    },
    "cms.update_draft": async () => {
      throw new Error("Webflow adapter is contract_only: no live request path.");
    },
    "cms.publish_approved_asset": async () => {
      throw new Error("Webflow adapter is contract_only: no live request path.");
    },
  },
  probe: async () =>
    unverifiableHealth("Webflow adapter is contract_only — there is no live probe to run."),
});

// ------------------------------------------------------------------ Slack

const slackConfig = z.object({
  defaultChannel: z.string().min(1, "Slack defaultChannel is required"),
});

export const slackConnector = buildAdapter({
  id: "slack",
  provider: "slack",
  version: "1.0.0",
  category: "notification",
  status: "implemented_unverified",
  configSchema: slackConfig,
  requiredScopes: ["chat:write"],
  outstandingWork: [
    "Never executed against a live Slack workspace.",
    "Block Kit formatting is not implemented — messages are plain text.",
  ],
  handlers: {
    "notification.send_internal": async (input, ctx) => {
      const config = slackConfig.parse(ctx.config);
      const text = requireString(input, "text", "notification.send_internal");
      const response = await ctx.http({
        url: "https://slack.com/api/chat.postMessage",
        method: "POST",
        headers: { authorization: `Bearer ${ctx.secret()}` },
        body: {
          channel: typeof input.channel === "string" ? input.channel : config.defaultChannel,
          text,
        },
      });
      const { data } = expectOk(response, (raw) => {
        const envelope = raw as { ok?: boolean; ts?: string; error?: string } | null;
        // Slack returns HTTP 200 with ok:false. Treating that as success is the
        // classic silent-failure bug in Slack integrations.
        if (envelope?.ok !== true) {
          throw new Error(`Slack rejected the message: ${envelope?.error ?? "unknown error"}`);
        }
        return { data: { messageTs: envelope.ts ?? "", delivered: true }, rowsWritten: 1 };
      });
      return { data, rowsWritten: 1 };
    },
  },
  probe: async (ctx) => {
    const started = Date.now();
    const response = await ctx.http({
      url: "https://slack.com/api/auth.test",
      method: "POST",
      headers: { authorization: `Bearer ${ctx.secret()}` },
    });
    const envelope = response.data as { ok?: boolean; error?: string } | null;
    const ok = response.ok && envelope?.ok === true;
    return {
      authorizationOk: ok,
      readOk: ok,
      latencyMs: Date.now() - started,
      errorCode: ok ? null : (envelope?.error ?? `http_${response.status}`),
      errorMessage: ok ? null : (envelope?.error ?? response.text),
    };
  },
});
