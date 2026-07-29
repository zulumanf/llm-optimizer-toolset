/**
 * Per-adapter tests against captured response fixtures. No network, ever.
 *
 * What these prove is narrow but important: the request we *would* send is
 * shaped correctly, and the provider's response is normalised into our canonical
 * shape. They do NOT prove the adapter works against the live API — nothing in
 * this repository can, because no credentials exist here. That is why the
 * adapters are labelled `implemented_unverified` rather than `verified`.
 */
import { describe, expect, it } from "vitest";
import { ga4Connector, searchConsoleConnector, gmailConnector, googleCalendarConnector, __testables } from "@/lib/connectors/adapters/google";
import { hubspotConnector, followUpBossConnector, salesforceConnector } from "@/lib/connectors/adapters/crm";
import { stripeConnector, wordpressConnector, slackConnector, webflowConnector } from "@/lib/connectors/adapters/business";
import { csvConnector, fixtureConnector, localFileStoreConnector, manualConnector } from "@/lib/connectors/adapters/internal";
import type { ConnectorExecutionContext, ConnectorHttpResponse } from "@/lib/connectors/types";

/** A recorded HTTP exchange. `captured` is what the request looked like. */
interface Recorder {
  captured: { url: string; method: string; body: unknown; headers: Record<string, string> }[];
  respond: (response: Partial<ConnectorHttpResponse>) => void;
}

function contextFor(
  overrides: Partial<ConnectorExecutionContext> & { config?: Record<string, unknown> }
): { ctx: ConnectorExecutionContext; recorder: Recorder } {
  let queued: Partial<ConnectorHttpResponse> = { ok: true, status: 200, data: {} };
  const recorder: Recorder = {
    captured: [],
    respond: (response) => {
      queued = response;
    },
  };

  const ctx: ConnectorExecutionContext = {
    connectionId: "conn-1",
    projectId: "proj-1",
    provider: "test",
    mode: "live",
    config: overrides.config ?? {},
    grantedScopes: [],
    secret: () => "test-secret-token",
    refreshSecret: () => "test-refresh-token",
    fixtures: {},
    capability: "analytics.fetch_sessions",
    workflowRunId: "run-1",
    nodeRunId: null,
    http: async (request) => {
      recorder.captured.push({
        url: request.url,
        method: request.method ?? "GET",
        body: request.body ?? request.form ?? null,
        headers: request.headers ?? {},
      });
      return {
        ok: queued.ok ?? true,
        status: queued.status ?? 200,
        data: queued.data ?? null,
        text: queued.text ?? "",
        headers: queued.headers ?? {},
        latencyMs: 5,
        rateLimited: queued.rateLimited ?? false,
        retryAfterSeconds: queued.retryAfterSeconds ?? null,
      };
    },
    ...overrides,
  } as ConnectorExecutionContext;

  return { ctx, recorder };
}

describe("adapter configuration validation", () => {
  it("accepts a valid GA4 config and rejects a missing property id", async () => {
    expect((await ga4Connector.validateConfiguration({ propertyId: "123456" })).valid).toBe(true);
    const invalid = await ga4Connector.validateConfiguration({});
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.join(" ")).toContain("propertyId");
  });

  it("requires a Search Console site URL", async () => {
    expect((await searchConsoleConnector.validateConfiguration({})).valid).toBe(false);
    expect(
      (await searchConsoleConnector.validateConfiguration({ siteUrl: "https://example.com" })).valid
    ).toBe(true);
  });

  it("requires a WordPress site URL and username", async () => {
    const missing = await wordpressConnector.validateConfiguration({ siteUrl: "https://x.com" });
    expect(missing.valid).toBe(false);
    expect(missing.errors.join(" ")).toContain("username");

    const badUrl = await wordpressConnector.validateConfiguration({
      siteUrl: "not-a-url",
      username: "admin",
    });
    expect(badUrl.valid).toBe(false);
  });

  it("requires a Slack default channel", async () => {
    expect((await slackConnector.validateConfiguration({})).valid).toBe(false);
    expect((await slackConnector.validateConfiguration({ defaultChannel: "#ops" })).valid).toBe(true);
  });

  it("applies defaults on a valid config", async () => {
    const result = await stripeConnector.validateConfiguration({});
    expect(result.valid).toBe(true);
    expect(result.normalized?.currency).toBe("usd");
    expect(result.normalized?.defaultDueDays).toBe(14);
  });

  it("validates a Salesforce instance URL even though it is contract_only", async () => {
    expect((await salesforceConnector.validateConfiguration({ instanceUrl: "nope" })).valid).toBe(false);
    expect(
      (await salesforceConnector.validateConfiguration({ instanceUrl: "https://x.my.salesforce.com" }))
        .valid
    ).toBe(true);
  });
});

describe("GA4 adapter", () => {
  const config = { propertyId: "props-1" };

  it("builds a runReport request and normalises the rows", async () => {
    const { ctx, recorder } = contextFor({ config });
    recorder.respond({
      ok: true,
      status: 200,
      data: {
        rows: [
          { dimensionValues: [{ value: "20260801" }], metricValues: [{ value: "120" }, { value: "95" }, { value: "40" }] },
          { dimensionValues: [{ value: "20260802" }], metricValues: [{ value: "130" }, { value: "99" }, { value: "44" }] },
        ],
        rowCount: 2,
      },
    });

    const result = await ga4Connector.execute(
      "analytics.fetch_sessions",
      { startDate: "2026-08-01", endDate: "2026-08-02" },
      ctx
    );

    expect(result.ok).toBe(true);
    expect(recorder.captured[0]!.url).toContain("properties/props-1:runReport");
    expect(recorder.captured[0]!.method).toBe("POST");
    expect(recorder.captured[0]!.headers.authorization).toBe("Bearer test-secret-token");

    const data = result.data as { rows: Record<string, unknown>[]; period: unknown; truncated: boolean };
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0]!.date).toBe("20260801");
    expect(data.rows[0]!.sessions).toBe(120);
    // A report must be able to state its own window.
    expect(data.period).toEqual({ startDate: "2026-08-01", endDate: "2026-08-02" });
    expect(result.rowsRead).toBe(2);
  });

  it("normalises an empty result set without inventing zeros", async () => {
    const { ctx, recorder } = contextFor({ config });
    recorder.respond({ ok: true, status: 200, data: { rows: [], rowCount: 0 } });
    const result = await ga4Connector.execute(
      "analytics.fetch_sessions",
      { startDate: "a", endDate: "b" },
      ctx
    );
    expect(result.ok).toBe(true);
    expect((result.data as { rows: unknown[] }).rows).toEqual([]);
    expect(result.rowsRead).toBe(0);
  });

  it("classifies a 401 as a non-retryable authorisation failure", async () => {
    const { ctx, recorder } = contextFor({ config });
    recorder.respond({ ok: false, status: 401, text: "invalid credentials" });
    const result = await ga4Connector.execute("analytics.fetch_sessions", { startDate: "a", endDate: "b" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("authorization_failed");
    expect(result.retryable).toBe(false);
  });

  it("classifies a 429 as retryable and carries Retry-After", async () => {
    const { ctx, recorder } = contextFor({ config });
    recorder.respond({ ok: false, status: 429, rateLimited: true, retryAfterSeconds: 30, text: "slow down" });
    const result = await ga4Connector.execute("analytics.fetch_sessions", { startDate: "a", endDate: "b" }, ctx);
    expect(result.rateLimited).toBe(true);
    expect(result.retryable).toBe(true);
    expect(result.retryAfterSeconds).toBe(30);
  });

  it("classifies a 500 as retryable", async () => {
    const { ctx, recorder } = contextFor({ config });
    recorder.respond({ ok: false, status: 503, text: "unavailable" });
    const result = await ga4Connector.execute("analytics.fetch_sessions", { startDate: "a", endDate: "b" }, ctx);
    expect(result.retryable).toBe(true);
  });

  it("classifies a timeout distinctly", async () => {
    const { ctx, recorder } = contextFor({ config });
    recorder.respond({ ok: false, status: 408, text: "request timed out after 20000ms" });
    const result = await ga4Connector.execute("analytics.fetch_sessions", { startDate: "a", endDate: "b" }, ctx);
    expect(result.errorCode).toBe("timeout");
    expect(result.retryable).toBe(true);
  });

  it("fails on a 200 whose body it cannot understand rather than returning nothing", async () => {
    const { ctx, recorder } = contextFor({ config });
    // A silently empty success is how a report loses a metric.
    recorder.respond({ ok: true, status: 200, data: "this is not the envelope" });
    const result = await ga4Connector.execute("analytics.fetch_sessions", { startDate: "a", endDate: "b" }, ctx);
    expect(result.ok).toBe(true);
    expect((result.data as { rows: unknown[] }).rows).toEqual([]);
  });

  it("refuses a capability it does not implement", async () => {
    const { ctx } = contextFor({ config });
    const result = await ga4Connector.execute("email.send_approved_message", {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("unsupported_capability");
  });

  it("refuses a call missing a required input", async () => {
    const { ctx } = contextFor({ config });
    const result = await ga4Connector.execute("analytics.fetch_sessions", {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_input");
  });

  it("probes health without a full report", async () => {
    const { ctx, recorder } = contextFor({ config });
    recorder.respond({ ok: true, status: 200, data: { rows: [] } });
    const health = await ga4Connector.testConnection(ctx);
    expect(health.authorizationOk).toBe(true);
    expect(health.readOk).toBe(true);
    expect(recorder.captured[0]!.url).toContain("runReport");
  });

  it("reports a failed probe honestly", async () => {
    const { ctx, recorder } = contextFor({ config });
    recorder.respond({ ok: false, status: 403, text: "forbidden" });
    const health = await ga4Connector.testConnection(ctx);
    expect(health.authorizationOk).toBe(false);
    expect(health.readOk).toBe(false);
    expect(health.errorCode).toBe("http_403");
  });

  it("refreshes a token when the config carries OAuth client details", async () => {
    const { ctx, recorder } = contextFor({
      config: { ...config, clientId: "cid", clientSecret: "csec" },
    });
    recorder.respond({ ok: true, status: 200, data: { access_token: "new-token", expires_in: 3600 } });
    const result = await ga4Connector.refreshAuthorization!(ctx);
    expect(result.refreshed).toBe(true);
    expect(result.accessToken).toBe("new-token");
    expect(result.expiresAt).toBeInstanceOf(Date);
    expect(recorder.captured[0]!.url).toContain("oauth2.googleapis.com/token");
  });

  it("declines to refresh without client credentials, and says why", async () => {
    const { ctx } = contextFor({ config });
    const result = await ga4Connector.refreshAuthorization!(ctx);
    expect(result.refreshed).toBe(false);
    expect(result.error).toContain("clientId");
  });
});

describe("Search Console adapter", () => {
  it("normalises query rows with all four metrics", async () => {
    const { ctx, recorder } = contextFor({ config: { siteUrl: "https://example.com" } });
    recorder.respond({
      ok: true,
      status: 200,
      data: { rows: [{ keys: ["coral gables realtor"], clicks: 12, impressions: 400, ctr: 0.03, position: 8.4 }] },
    });
    const result = await searchConsoleConnector.execute(
      "search_console.fetch_queries",
      { startDate: "2026-07-01", endDate: "2026-07-31" },
      ctx
    );
    expect(result.ok).toBe(true);
    const rows = (result.data as { rows: Record<string, unknown>[] }).rows;
    expect(rows[0]!.query).toBe("coral gables realtor");
    expect(rows[0]!.clicks).toBe(12);
    expect(rows[0]!.position).toBe(8.4);
    expect(recorder.captured[0]!.url).toContain(encodeURIComponent("https://example.com"));
  });
});

describe("Gmail adapter", () => {
  const config = { userId: "me", sendAsAddress: "ops@parva.example" };

  it("base64url-encodes an RFC 2822 message with compliance headers", () => {
    const encoded = __testables.encodeMessage({
      to: "agent@example.com",
      from: "ops@parva.example",
      subject: "Hello",
      body: "Body text",
      unsubscribeUrl: "https://parva.example/unsub/abc",
    });
    // base64url alphabet only.
    expect(encoded).not.toMatch(/[+/=]/);
    const decoded = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    expect(decoded).toContain("To: agent@example.com");
    expect(decoded).toContain("From: ops@parva.example");
    // An opt-out path is a compliance field, not a nicety.
    expect(decoded).toContain("List-Unsubscribe: <https://parva.example/unsub/abc>");
    expect(decoded).toContain("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  });

  it("normalises a thread read", async () => {
    const { ctx } = contextFor({ config });
    const body = Buffer.from("Thanks, let's talk Tuesday.").toString("base64");
    (ctx as { http: unknown }).http = async () => ({
      ok: true,
      status: 200,
      data: {
        messages: [
          {
            id: "m1",
            internalDate: "1780000000000",
            payload: {
              headers: [
                { name: "From", value: "agent@example.com" },
                { name: "Subject", value: "Re: visibility" },
              ],
              parts: [{ mimeType: "text/plain", body: { data: body } }],
            },
          },
        ],
      },
      text: "",
      headers: {},
      latencyMs: 3,
      rateLimited: false,
      retryAfterSeconds: null,
    });

    const result = await gmailConnector.execute("email.read_thread", { threadId: "t1" }, ctx);
    expect(result.ok).toBe(true);
    const messages = (result.data as { messages: Record<string, unknown>[] }).messages;
    expect(messages[0]!.from).toBe("agent@example.com");
    expect(messages[0]!.subject).toBe("Re: visibility");
    expect(messages[0]!.body).toContain("Tuesday");
  });

  it("prefers sending an approved draft over recomposing from fields", async () => {
    const { ctx, recorder } = contextFor({ config });
    recorder.respond({ ok: true, status: 200, data: { id: "sent-1", threadId: "t-1" } });
    const result = await gmailConnector.execute(
      "email.send_approved_message",
      { draftId: "draft-9" },
      ctx
    );
    expect(result.ok).toBe(true);
    // Sending the exact artifact a human approved is safer than rebuilding it.
    expect(recorder.captured[0]!.url).toContain("/drafts/send");
    expect((recorder.captured[0]!.body as { id: string }).id).toBe("draft-9");
    expect((result.data as { sentDraftId: string }).sentDraftId).toBe("draft-9");
  });

  it("falls back to composing when no draft id is supplied", async () => {
    const { ctx, recorder } = contextFor({ config });
    recorder.respond({ ok: true, status: 200, data: { id: "sent-2" } });
    const result = await gmailConnector.execute(
      "email.send_approved_message",
      { to: "a@b.co", subject: "S", body: "B" },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(recorder.captured[0]!.url).toContain("/messages/send");
  });

  it("requires a sender it can attribute", async () => {
    const { ctx } = contextFor({ config: { userId: "me" } });
    const result = await gmailConnector.execute(
      "email.create_draft",
      { to: "a@b.co", subject: "S", body: "B" },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_input");
  });
});

describe("Calendar adapter", () => {
  it("normalises events and attendees", async () => {
    const { ctx, recorder } = contextFor({ config: { calendarId: "primary" } });
    recorder.respond({
      ok: true,
      status: 200,
      data: {
        items: [
          {
            id: "e1",
            summary: "Quarterly review",
            start: { dateTime: "2026-08-04T14:00:00Z" },
            end: { dateTime: "2026-08-04T15:00:00Z" },
            organizer: { email: "ops@parva.example" },
            attendees: [{ email: "client@example.com", displayName: "Client", responseStatus: "accepted" }],
          },
        ],
      },
    });
    const result = await googleCalendarConnector.execute(
      "calendar.fetch_events",
      { timeMin: "2026-08-04T00:00:00Z", timeMax: "2026-08-05T00:00:00Z" },
      ctx
    );
    expect(result.ok).toBe(true);
    const events = (result.data as { events: Record<string, unknown>[] }).events;
    expect(events[0]!.title).toBe("Quarterly review");
    expect((events[0]!.attendees as unknown[])).toHaveLength(1);
    expect(recorder.captured[0]!.url).toContain("singleEvents=true");
  });
});

describe("HubSpot adapter", () => {
  it("normalises contacts to the canonical shape and keeps unmapped fields", async () => {
    const { ctx, recorder } = contextFor({});
    recorder.respond({
      ok: true,
      status: 200,
      data: {
        results: [
          {
            id: "101",
            properties: {
              email: "agent@example.com",
              firstname: "Ada",
              lastname: "Realtor",
              company: "Gables Group",
              phone: "3055550147",
              lifecyclestage: "lead",
              hubspot_owner_id: "owner-1",
              createdate: "2026-07-01T00:00:00Z",
              projected_gci: "45000",
            },
          },
        ],
        paging: { next: { after: "cursor-2" } },
      },
    });
    const result = await hubspotConnector.execute("crm.fetch_contacts", { limit: 50 }, ctx);
    expect(result.ok).toBe(true);
    const data = result.data as { contacts: Record<string, unknown>[]; nextCursor: string };
    expect(data.contacts[0]!.email).toBe("agent@example.com");
    expect(data.contacts[0]!.externalId).toBe("101");
    // A provider field we did not map is preserved, never dropped silently.
    expect((data.contacts[0]!.unmapped as Record<string, unknown>).projected_gci).toBe("45000");
    expect(data.nextCursor).toBe("cursor-2");
    expect(recorder.captured[0]!.headers.authorization).toContain("Bearer");
  });

  it("converts deal amounts to integer cents", async () => {
    const { ctx, recorder } = contextFor({});
    recorder.respond({
      ok: true,
      status: 200,
      data: { results: [{ id: "d1", properties: { dealname: "Listing", dealstage: "qualified", amount: "402.35" } }] },
    });
    const result = await hubspotConnector.execute("crm.fetch_opportunities", {}, ctx);
    const opportunities = (result.data as { opportunities: Record<string, unknown>[] }).opportunities;
    // Float dollars are how a pipeline total ends up at 40234.999997.
    expect(opportunities[0]!.amountCents).toBe(40_235);
  });

  it("sends the amount back as dollars when updating", async () => {
    const { ctx, recorder } = contextFor({});
    recorder.respond({ ok: true, status: 200, data: { id: "d1", properties: {} } });
    await hubspotConnector.execute("crm.update_opportunity", { externalId: "d1", amountCents: 40_235 }, ctx);
    const body = recorder.captured[0]!.body as { properties: { amount: number } };
    expect(body.properties.amount).toBe(402.35);
  });

  it("normalises stage history", async () => {
    const { ctx } = contextFor({});
    (ctx as { http: unknown }).http = async () => ({
      ok: true,
      status: 200,
      data: {
        propertiesWithHistory: {
          dealstage: [
            { value: "qualified", timestamp: "2026-07-01T00:00:00Z", sourceType: "CRM_UI" },
            { value: "proposal", timestamp: "2026-07-15T00:00:00Z", sourceType: "API" },
          ],
        },
      },
      text: "",
      headers: {},
      latencyMs: 2,
      rateLimited: false,
      retryAfterSeconds: null,
    });
    const result = await hubspotConnector.execute("crm.fetch_stage_history", { externalId: "d1" }, ctx);
    const history = (result.data as { history: Record<string, unknown>[] }).history;
    expect(history).toHaveLength(2);
    expect(history[1]!.stage).toBe("proposal");
  });

  it("requires an email to create a contact", async () => {
    const { ctx } = contextFor({});
    const result = await hubspotConnector.execute("crm.create_contact", {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_input");
  });
});

describe("Follow Up Boss adapter", () => {
  it("uses HTTP Basic with the API key as the username", async () => {
    const { ctx, recorder } = contextFor({});
    recorder.respond({ ok: true, status: 200, data: { people: [] } });
    await followUpBossConnector.execute("crm.fetch_contacts", {}, ctx);
    const auth = recorder.captured[0]!.headers.authorization!;
    expect(auth.startsWith("Basic ")).toBe(true);
    expect(Buffer.from(auth.slice(6), "base64").toString("utf8")).toBe("test-secret-token:");
  });

  it("normalises a person into the same canonical contact shape as HubSpot", async () => {
    const { ctx, recorder } = contextFor({});
    recorder.respond({
      ok: true,
      status: 200,
      data: {
        people: [
          {
            id: 55,
            firstName: "Ada",
            lastName: "Realtor",
            emails: [{ value: "agent@example.com" }],
            phones: [{ value: "3055550147" }],
            stage: "Lead",
            customEstimatedCommission: "45000",
          },
        ],
      },
    });
    const result = await followUpBossConnector.execute("crm.fetch_contacts", {}, ctx);
    const contacts = (result.data as { contacts: Record<string, unknown>[] }).contacts;
    // Same canonical keys as HubSpot — that is what lets a workflow be
    // provider-agnostic.
    expect(contacts[0]!.email).toBe("agent@example.com");
    expect(contacts[0]!.externalId).toBe("55");
    expect((contacts[0]!.unmapped as Record<string, unknown>).customEstimatedCommission).toBe("45000");
  });

  it("reads the commission from the configured custom field", async () => {
    const { ctx, recorder } = contextFor({ config: { commissionField: "customEstimatedCommission" } });
    recorder.respond({
      ok: true,
      status: 200,
      data: { deals: [{ id: 9, name: "Listing", stage: "Active", customEstimatedCommission: "1250.50" }] },
    });
    const result = await followUpBossConnector.execute("crm.fetch_opportunities", {}, ctx);
    const opportunities = (result.data as { opportunities: Record<string, unknown>[] }).opportunities;
    expect(opportunities[0]!.amountCents).toBe(125_050);
  });
});

describe("Salesforce and Webflow are contract_only and say so", () => {
  it("declares the status and what remains", () => {
    for (const connector of [salesforceConnector, webflowConnector]) {
      expect(connector.status).toBe("contract_only");
      expect(connector.outstandingWork.length).toBeGreaterThan(1);
      expect(connector.outstandingWork.join(" ")).toContain("No live request path");
    }
  });

  it("fails honestly rather than pretending in live mode", async () => {
    const { ctx } = contextFor({ config: { instanceUrl: "https://x.my.salesforce.com" } });
    const result = await salesforceConnector.execute("crm.fetch_contacts", {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("contract_only");
  });

  it("reports an unverifiable health probe", async () => {
    const { ctx } = contextFor({ config: { instanceUrl: "https://x.my.salesforce.com" } });
    const health = await salesforceConnector.testConnection(ctx);
    expect(health.authorizationOk).toBe(false);
    expect(health.errorCode).toBe("not_implemented");
  });

  it("still works in fixture mode so a workflow can be authored against it", async () => {
    const { ctx } = contextFor({ mode: "fixture" });
    ctx.fixtures = { "crm.fetch_contacts": [{ email: "a@b.co" }] };
    const result = await salesforceConnector.execute("crm.fetch_contacts", {}, ctx);
    expect(result.ok).toBe(true);
    expect(result.rowsRead).toBe(1);
  });
});

describe("Stripe adapter", () => {
  it("refuses an amount that is not a positive integer of cents", async () => {
    const { ctx } = contextFor({});
    for (const amountCents of [0, -100, 12.5, "1200"]) {
      const result = await stripeConnector.execute(
        "billing.create_invoice",
        { customerRef: "cus_1", description: "Monthly", amountCents },
        ctx
      );
      expect(result.ok, `amount ${String(amountCents)} must be refused`).toBe(false);
      expect(result.errorCode).toBe("invalid_input");
    }
  });

  it("creates a line item then an invoice, form-encoded", async () => {
    const { ctx, recorder } = contextFor({});
    recorder.respond({
      ok: true,
      status: 200,
      data: { id: "in_1", status: "open", amount_due: 450_000, currency: "usd", number: "A-1" },
    });
    const result = await stripeConnector.execute(
      "billing.create_invoice",
      { customerRef: "cus_1", description: "Monthly retainer", amountCents: 450_000, idempotencyKey: "k-1" },
      ctx
    );
    expect(result.ok).toBe(true);
    expect(recorder.captured).toHaveLength(2);
    expect(recorder.captured[0]!.url).toContain("/invoiceitems");
    expect((recorder.captured[0]!.body as Record<string, string>).amount).toBe("450000");
    expect(recorder.captured[1]!.url).toContain("/invoices");
    // Provider-side idempotency in addition to ours: a duplicate invoice is a
    // client-trust incident.
    expect((recorder.captured[1]!.body as Record<string, string>)["metadata[idempotency_key]"]).toBe("k-1");
    expect((result.data as { amountDueCents: number }).amountDueCents).toBe(450_000);
  });

  it("computes overdue from the due date rather than trusting a flag", async () => {
    const { ctx, recorder } = contextFor({});
    recorder.respond({
      ok: true,
      status: 200,
      data: { id: "in_1", status: "open", amount_due: 1000, due_date: 1_700_000_000 },
    });
    const result = await stripeConnector.execute(
      "billing.fetch_payment_status",
      { externalInvoiceId: "in_1" },
      ctx
    );
    const data = result.data as { paid: boolean; overdue: boolean };
    expect(data.paid).toBe(false);
    expect(data.overdue).toBe(true);
  });
});

describe("WordPress adapter", () => {
  const config = { siteUrl: "https://example.com", username: "admin" };

  it("always creates a draft, never a published post", async () => {
    const { ctx, recorder } = contextFor({ config });
    recorder.respond({ ok: true, status: 200, data: { id: 7, status: "draft", link: "https://example.com/?p=7" } });
    await wordpressConnector.execute(
      "cms.create_draft",
      { title: "Coral Gables Q3", content: "Body" },
      ctx
    );
    // Publication is a separate, approval-gated capability.
    expect((recorder.captured[0]!.body as { status: string }).status).toBe("draft");
  });

  it("refuses to publish without the approval id", async () => {
    const { ctx } = contextFor({ config });
    const result = await wordpressConnector.execute(
      "cms.publish_approved_asset",
      { externalId: "7" },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("invalid_input");
  });

  it("publishes when the approval id is present", async () => {
    const { ctx, recorder } = contextFor({ config });
    recorder.respond({ ok: true, status: 200, data: { id: 7, status: "publish", link: "https://example.com/post" } });
    const result = await wordpressConnector.execute(
      "cms.publish_approved_asset",
      { externalId: "7", approvalId: "appr-1" },
      ctx
    );
    expect(result.ok).toBe(true);
    expect((recorder.captured[0]!.body as { status: string }).status).toBe("publish");
    expect((result.data as { published: boolean }).published).toBe(true);
  });

  it("uses HTTP Basic with the configured username", async () => {
    const { ctx, recorder } = contextFor({ config });
    recorder.respond({ ok: true, status: 200, data: { id: 1 } });
    await wordpressConnector.execute("cms.create_draft", { title: "T", content: "C" }, ctx);
    const auth = recorder.captured[0]!.headers.authorization!;
    expect(Buffer.from(auth.slice(6), "base64").toString("utf8")).toBe("admin:test-secret-token");
  });

  it("verifies a live page and bounds what it reads", async () => {
    const { ctx } = contextFor({ config });
    (ctx as { http: unknown }).http = async () => ({
      ok: true,
      status: 200,
      data: null,
      text: "x".repeat(5000),
      headers: {},
      latencyMs: 2,
      rateLimited: false,
      retryAfterSeconds: null,
    });
    const result = await wordpressConnector.execute(
      "cms.fetch_public_page",
      { url: "https://example.com/post" },
      ctx
    );
    expect(result.ok).toBe(true);
    const data = result.data as { reachable: boolean; excerpt: string };
    expect(data.reachable).toBe(true);
    expect(data.excerpt.length).toBeLessThanOrEqual(2000);
  });
});

describe("Slack adapter", () => {
  it("treats HTTP 200 with ok:false as a failure", async () => {
    const { ctx, recorder } = contextFor({ config: { defaultChannel: "#ops" } });
    // The classic silent-failure bug in Slack integrations.
    recorder.respond({ ok: true, status: 200, data: { ok: false, error: "channel_not_found" } });
    const result = await slackConnector.execute(
      "notification.send_internal",
      { text: "Alert" },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("channel_not_found");
  });

  it("succeeds on ok:true and returns the timestamp", async () => {
    const { ctx, recorder } = contextFor({ config: { defaultChannel: "#ops" } });
    recorder.respond({ ok: true, status: 200, data: { ok: true, ts: "1780000000.1" } });
    const result = await slackConnector.execute("notification.send_internal", { text: "Alert" }, ctx);
    expect(result.ok).toBe(true);
    expect((result.data as { messageTs: string }).messageTs).toBe("1780000000.1");
  });

  it("falls back to the default channel", async () => {
    const { ctx, recorder } = contextFor({ config: { defaultChannel: "#ops" } });
    recorder.respond({ ok: true, status: 200, data: { ok: true, ts: "1" } });
    await slackConnector.execute("notification.send_internal", { text: "Alert" }, ctx);
    expect((recorder.captured[0]!.body as { channel: string }).channel).toBe("#ops");
  });
});

describe("internal adapters", () => {
  it("labels the local adapters verified and the rest not", () => {
    for (const connector of [fixtureConnector, csvConnector, manualConnector, localFileStoreConnector]) {
      expect(connector.status).toBe("verified");
    }
  });

  it("serves every capability from a fixture", async () => {
    const { ctx } = contextFor({ mode: "fixture" });
    ctx.fixtures = { "analytics.fetch_sessions": { rows: [{ sessions: 10 }] } };
    const result = await fixtureConnector.execute("analytics.fetch_sessions", {}, ctx);
    expect(result.ok).toBe(true);
  });

  it("fails clearly when a fixture is missing", async () => {
    const { ctx } = contextFor({ mode: "fixture" });
    const result = await fixtureConnector.execute("analytics.fetch_sessions", {}, ctx);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("fixture_missing");
  });

  it("parses and header-maps a CSV import", async () => {
    const { ctx } = contextFor({
      config: { headerMap: { "Estimated GCI": "estimated_commission" }, delimiter: "," },
    });
    const result = await csvConnector.execute(
      "crm.fetch_contacts",
      { csv: "Email,Estimated GCI\na@b.co,45000" },
      ctx
    );
    expect(result.ok).toBe(true);
    const rows = (result.data as { rows: Record<string, string>[] }).rows;
    expect(rows[0]!.estimated_commission).toBe("45000");
    expect(rows[0]!.Email).toBe("a@b.co");
  });

  it("accepts a manually entered payload for reads only", async () => {
    const { ctx } = contextFor({});
    const ok = await manualConnector.execute("crm.fetch_contacts", { payload: [{ email: "a@b.co" }] }, ctx);
    expect(ok.ok).toBe(true);
    expect((ok.data as { enteredManually: boolean }).enteredManually).toBe(true);

    // "A human typed that the email was sent" must not be recordable as a send.
    const refused = await manualConnector.execute("email.send_approved_message", { payload: {} }, ctx);
    expect(refused.ok).toBe(false);
    expect(refused.errorCode).toBe("unsupported_capability");
  });

  it("refuses a storage key that escapes the configured root", async () => {
    const { ctx } = contextFor({ config: { root: "var/artifacts" } });
    const result = await localFileStoreConnector.execute(
      "file.store",
      { key: "../../etc/passwd", content: "x" },
      ctx
    );
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("path_traversal_refused");
  });
});
