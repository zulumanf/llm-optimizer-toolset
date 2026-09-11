/**
 * Google adapters: GA4 Data API, Search Console API, Gmail, Calendar.
 *
 * STATUS: `implemented_unverified`. Each handler is written against the
 * provider's documented HTTP contract and its request/response shape is tested
 * against captured fixtures — but no call in this file has ever been executed
 * against the live API, because no Google credentials exist in this
 * environment. That is stated in the adapter's `status` and `outstandingWork`,
 * shown in the connectors UI, and repeated in specs/connector-sdk.md. Nothing
 * here is production-ready until someone runs it with real credentials.
 */
import { z } from "zod";
import { connectorFetch } from "@/lib/connectors/http";
import {
  buildAdapter,
  expectOk,
  requireString,
  type CapabilityHandler,
} from "@/lib/connectors/adapters/base";
import type { ConnectorContext, ConnectionHealthResult } from "@/lib/connectors/types";

const OUTSTANDING = [
  "Never executed against the live Google API — no credentials in this environment.",
  "OAuth authorisation-code flow is not wired; the access token is pasted.",
  "Quota and per-property concurrency limits are untested under real load.",
];

function bearer(ctx: ConnectorContext): Record<string, string> {
  return { authorization: `Bearer ${ctx.secret()}` };
}

/**
 * A single OAuth refresh implementation, shared by all four Google adapters.
 * Needs a client id and secret in the connection config; without them it says
 * so rather than failing opaquely.
 */
async function googleRefresh(ctx: ConnectorContext) {
  const clientId = typeof ctx.config.clientId === "string" ? ctx.config.clientId : "";
  const clientSecret =
    typeof ctx.config.clientSecret === "string" ? ctx.config.clientSecret : "";
  const refreshToken = ctx.refreshSecret();
  if (!clientId || !clientSecret || !refreshToken) {
    return {
      refreshed: false,
      error:
        "Refresh needs clientId and clientSecret in the connection config plus a stored refresh token.",
    };
  }
  const response = await ctx.http({
    url: "https://oauth2.googleapis.com/token",
    method: "POST",
    form: {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    },
    // Without this, the http layer redacts access_token in the response and
    // the literal "[redacted]" gets stored as the credential.
    rawSecrets: true,
  });
  if (!response.ok) {
    return { refreshed: false, error: `token endpoint returned ${response.status}` };
  }
  const data = response.data as { access_token?: string; expires_in?: number } | null;
  if (!data?.access_token) return { refreshed: false, error: "no access_token in response" };
  return {
    refreshed: true,
    accessToken: data.access_token,
    expiresAt: data.expires_in ? new Date(Date.now() + data.expires_in * 1000) : null,
  };
}

// ------------------------------------------------------------------- GA4

const ga4Config = z.object({
  propertyId: z.string().min(1, "GA4 propertyId is required"),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

const GA4_BASE = "https://analyticsdata.googleapis.com/v1beta";

interface Ga4Row {
  dimensionValues?: { value?: string }[];
  metricValues?: { value?: string }[];
}

/**
 * One shape for every GA4 report call. Returning `{ rows, dimensions, metrics,
 * period }` rather than the provider's raw envelope means downstream nodes are
 * written against our shape, not Google's — which is the whole point of the
 * capability layer.
 */
function ga4Report(dimensions: string[], metrics: string[]): CapabilityHandler {
  return async (input, ctx) => {
    const config = ga4Config.parse(ctx.config);
    const startDate = requireString(input, "startDate", "analytics fetch");
    const endDate = requireString(input, "endDate", "analytics fetch");
    const limit = typeof input.limit === "number" ? Math.min(input.limit, 10_000) : 1000;

    const response = await ctx.http({
      url: `${GA4_BASE}/properties/${encodeURIComponent(config.propertyId)}:runReport`,
      method: "POST",
      headers: bearer(ctx),
      body: {
        dateRanges: [{ startDate, endDate }],
        dimensions: dimensions.map((name) => ({ name })),
        metrics: metrics.map((name) => ({ name })),
        limit,
      },
    });

    const { data } = expectOk(response, (raw) => {
      const envelope = raw as { rows?: Ga4Row[]; rowCount?: number } | null;
      const rows = (envelope?.rows ?? []).map((row) => {
        const record: Record<string, string | number> = {};
        dimensions.forEach((name, index) => {
          record[name] = row.dimensionValues?.[index]?.value ?? "";
        });
        metrics.forEach((name, index) => {
          record[name] = Number(row.metricValues?.[index]?.value ?? 0);
        });
        return record;
      });
      return {
        data: {
          rows,
          dimensions,
          metrics,
          // Reporting must be able to state its own denominator and window.
          period: { startDate, endDate },
          rowCount: envelope?.rowCount ?? rows.length,
          truncated: rows.length >= limit,
        },
        rowsRead: rows.length,
      };
    });
    return { data, rowsRead: (data as { rows: unknown[] }).rows.length };
  };
}

async function ga4Probe(ctx: ConnectorContext): Promise<ConnectionHealthResult> {
  const config = ga4Config.parse(ctx.config);
  const started = Date.now();
  const response = await ctx.http({
    url: `${GA4_BASE}/properties/${encodeURIComponent(config.propertyId)}:runReport`,
    method: "POST",
    headers: bearer(ctx),
    body: {
      dateRanges: [{ startDate: "7daysAgo", endDate: "yesterday" }],
      metrics: [{ name: "sessions" }],
      limit: 1,
    },
  });
  return {
    authorizationOk: response.status !== 401 && response.status !== 403,
    readOk: response.ok,
    latencyMs: Date.now() - started,
    errorCode: response.ok ? null : `http_${response.status}`,
    errorMessage: response.ok ? null : response.text,
  };
}

export const ga4Connector = buildAdapter({
  id: "ga4",
  provider: "ga4",
  version: "1.0.0",
  category: "analytics",
  status: "implemented_unverified",
  configSchema: ga4Config,
  requiredScopes: ["https://www.googleapis.com/auth/analytics.readonly"],
  outstandingWork: OUTSTANDING,
  handlers: {
    "analytics.fetch_sessions": ga4Report(["date"], ["sessions", "totalUsers", "newUsers"]),
    "analytics.fetch_events": ga4Report(["eventName"], ["eventCount"]),
    "analytics.fetch_landing_pages": ga4Report(
      ["landingPagePlusQueryString"],
      ["sessions", "conversions"]
    ),
    // Referral source is how AI-assistant traffic is identified at all, so it
    // gets its own capability rather than being a filter on sessions.
    "analytics.fetch_referrals": ga4Report(
      ["sessionSource", "sessionMedium"],
      ["sessions", "conversions"]
    ),
  },
  probe: ga4Probe,
  refresh: googleRefresh,
});

// -------------------------------------------------------- Search Console

const gscConfig = z.object({
  siteUrl: z.string().min(1, "Search Console siteUrl is required"),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

const GSC_BASE = "https://searchconsole.googleapis.com/webmasters/v3";

function gscQuery(dimensions: string[]): CapabilityHandler {
  return async (input, ctx) => {
    const config = gscConfig.parse(ctx.config);
    const startDate = requireString(input, "startDate", "search console fetch");
    const endDate = requireString(input, "endDate", "search console fetch");
    const rowLimit = typeof input.limit === "number" ? Math.min(input.limit, 25_000) : 1000;

    const response = await ctx.http({
      url: `${GSC_BASE}/sites/${encodeURIComponent(config.siteUrl)}/searchAnalytics/query`,
      method: "POST",
      headers: bearer(ctx),
      body: { startDate, endDate, dimensions, rowLimit },
    });

    const { data } = expectOk(response, (raw) => {
      const envelope = raw as
        | { rows?: { keys?: string[]; clicks?: number; impressions?: number; ctr?: number; position?: number }[] }
        | null;
      const rows = (envelope?.rows ?? []).map((row) => {
        const record: Record<string, string | number> = {};
        dimensions.forEach((name, index) => {
          record[name] = row.keys?.[index] ?? "";
        });
        record.clicks = Number(row.clicks ?? 0);
        record.impressions = Number(row.impressions ?? 0);
        record.ctr = Number(row.ctr ?? 0);
        record.position = Number(row.position ?? 0);
        return record;
      });
      return {
        data: { rows, dimensions, period: { startDate, endDate }, truncated: rows.length >= rowLimit },
        rowsRead: rows.length,
      };
    });
    return { data, rowsRead: (data as { rows: unknown[] }).rows.length };
  };
}

export const searchConsoleConnector = buildAdapter({
  id: "search_console",
  provider: "search_console",
  version: "1.0.0",
  category: "search_console",
  status: "implemented_unverified",
  configSchema: gscConfig,
  requiredScopes: ["https://www.googleapis.com/auth/webmasters.readonly"],
  outstandingWork: OUTSTANDING,
  handlers: {
    "search_console.fetch_queries": gscQuery(["query"]),
    "search_console.fetch_pages": gscQuery(["page"]),
  },
  probe: async (ctx) => {
    const config = gscConfig.parse(ctx.config);
    const started = Date.now();
    const response = await ctx.http({
      url: `${GSC_BASE}/sites/${encodeURIComponent(config.siteUrl)}`,
      headers: bearer(ctx),
    });
    return {
      authorizationOk: response.status !== 401 && response.status !== 403,
      readOk: response.ok,
      latencyMs: Date.now() - started,
      errorCode: response.ok ? null : `http_${response.status}`,
      errorMessage: response.ok ? null : response.text,
    };
  },
  refresh: googleRefresh,
});

// ------------------------------------------------------------------ Gmail

const gmailConfig = z.object({
  userId: z.string().default("me"),
  /** The address outbound mail must come from. Verified before every send. */
  sendAsAddress: z.string().email().optional(),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

/** RFC 2822 message, base64url encoded as Gmail requires. With an
 * `htmlBody`, emits multipart/alternative (plain text first, HTML second —
 * RFC 2046 puts the preferred form last); plain-text-only messages carry
 * the same headers and body as before spec 092. */
function encodeMessage(args: {
  to: string;
  from: string;
  subject: string;
  body: string;
  htmlBody?: string;
  replyTo?: string;
  unsubscribeUrl?: string;
  inReplyTo?: string;
  references?: string;
  messageId?: string;
}): string {
  const headers = [`To: ${args.to}`, `From: ${args.from}`, `Subject: ${args.subject}`];
  if (args.replyTo) headers.push(`Reply-To: ${args.replyTo}`);
  if (args.messageId) headers.push(`Message-ID: ${args.messageId}`);
  if (args.inReplyTo) headers.push(`In-Reply-To: ${args.inReplyTo}`);
  if (args.references) headers.push(`References: ${args.references}`);
  // A one-click unsubscribe header is a compliance field, not a nicety.
  if (args.unsubscribeUrl) {
    headers.push(`List-Unsubscribe: <${args.unsubscribeUrl}>`);
    headers.push("List-Unsubscribe-Post: List-Unsubscribe=One-Click");
  }
  let payload: string;
  if (args.htmlBody) {
    // Static boundary is safe: it can only collide with body text, and both
    // parts are platform-generated from the approved draft.
    const boundary = "=_avos_alt_boundary";
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    headers.push("MIME-Version: 1.0");
    payload =
      `--${boundary}\r\n` +
      'Content-Type: text/plain; charset="UTF-8"\r\n\r\n' +
      `${args.body}\r\n` +
      `--${boundary}\r\n` +
      'Content-Type: text/html; charset="UTF-8"\r\n\r\n' +
      `${args.htmlBody}\r\n` +
      `--${boundary}--`;
  } else {
    headers.push('Content-Type: text/plain; charset="UTF-8"');
    headers.push("MIME-Version: 1.0");
    payload = args.body;
  }
  return Buffer.from(`${headers.join("\r\n")}\r\n\r\n${payload}`, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function decodeBody(part: { data?: string } | undefined): string {
  if (!part?.data) return "";
  return Buffer.from(part.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

interface RawGmailPart {
  mimeType?: string;
  body?: { data?: string };
  parts?: RawGmailPart[];
}
interface RawGmailMessage {
  id?: string;
  threadId?: string;
  internalDate?: string;
  labelIds?: string[];
  payload?: RawGmailPart & { headers?: { name?: string; value?: string }[] };
}
export interface ParsedGmailMessage {
  id: string;
  threadId: string | null;
  /** RFC 5322 Message-ID header — what In-Reply-To/References must cite. */
  messageId: string | null;
  from: string;
  to: string;
  subject: string;
  date: string | null;
  labelIds: string[];
  body: string;
}

function firstPartOf(part: RawGmailPart | undefined, mimeType: string): RawGmailPart | undefined {
  if (!part) return undefined;
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const p of part.parts ?? []) {
    const found = firstPartOf(p, mimeType);
    if (found) return found;
  }
  return undefined;
}

/** Plain text of an HTML-only message (spec 130): a reply sent from a
 * client that emits no text/plain part must still yield its words, not an
 * empty body that ingestion replaces with the subject line. */
export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Body text of a message: the first text/plain part, else the first
 * text/html part stripped to text, else the top-level body. */
export function gmailBodyText(payload: RawGmailPart | undefined): string {
  const plain = firstPartOf(payload, "text/plain");
  if (plain) return decodeBody(plain.body);
  const html = firstPartOf(payload, "text/html");
  if (html) return htmlToText(decodeBody(html.body));
  const top = decodeBody(payload?.body);
  return payload?.mimeType === "text/html" ? htmlToText(top) : top;
}

function parseGmailMessage(message: RawGmailMessage): ParsedGmailMessage {
  const headers = new Map(
    (message.payload?.headers ?? []).map((h) => [(h.name ?? "").toLowerCase(), h.value ?? ""])
  );
  return {
    id: message.id ?? "",
    threadId: message.threadId ?? null,
    messageId: headers.get("message-id") ?? null,
    from: headers.get("from") ?? "",
    to: headers.get("to") ?? "",
    subject: headers.get("subject") ?? "",
    date: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
    labelIds: message.labelIds ?? [],
    body: gmailBodyText(message.payload),
  };
}

export const gmailConnector = buildAdapter({
  id: "gmail",
  provider: "gmail",
  version: "1.0.0",
  category: "email",
  status: "implemented_unverified",
  configSchema: gmailConfig,
  requiredScopes: [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
    "https://www.googleapis.com/auth/gmail.send",
  ],
  outstandingWork: [
    ...OUTSTANDING,
    "Thread pagination beyond the first page is not implemented.",
  ],
  handlers: {
    "email.read_thread": async (input, ctx) => {
      const config = gmailConfig.parse(ctx.config);
      const threadId = requireString(input, "threadId", "email.read_thread");
      const response = await ctx.http({
        url: `${GMAIL_BASE}/users/${encodeURIComponent(config.userId)}/threads/${encodeURIComponent(threadId)}?format=full`,
        headers: bearer(ctx),
        // Message bodies are base64url; without this the redactor replaces
        // them with "[redacted]" (found live 2026-09-03, spec 127).
        rawSecrets: true,
      });
      const { data } = expectOk(response, (raw) => {
        const envelope = raw as { messages?: RawGmailMessage[] } | null;
        const messages = (envelope?.messages ?? []).map(parseGmailMessage);
        return { data: { threadId, messages }, rowsRead: messages.length };
      });
      return { data, rowsRead: (data as { messages: unknown[] }).messages.length };
    },
    // Spec 127: inbox search for reply ingestion and pre-dispatch checks.
    // Lists ids for a Gmail query, then fetches each message in full.
    "email.search_messages": async (input, ctx) => {
      const config = gmailConfig.parse(ctx.config);
      const q = requireString(input, "q", "email.search_messages");
      const max = typeof input.maxResults === "number" ? Math.min(input.maxResults, 100) : 50;
      const list = await ctx.http({
        url: `${GMAIL_BASE}/users/${encodeURIComponent(config.userId)}/messages?q=${encodeURIComponent(q)}&maxResults=${max}`,
        headers: bearer(ctx),
      });
      const { data: ids } = expectOk(list, (raw) => {
        const envelope = raw as { messages?: { id?: string }[] } | null;
        return {
          data: (envelope?.messages ?? []).map((m) => m.id ?? "").filter((id) => id.length > 0),
          rowsRead: 0,
        };
      });
      const messages: ParsedGmailMessage[] = [];
      for (const id of ids as string[]) {
        const res = await ctx.http({
          url: `${GMAIL_BASE}/users/${encodeURIComponent(config.userId)}/messages/${encodeURIComponent(id)}?format=full`,
          headers: bearer(ctx),
          rawSecrets: true,
        });
        const { data } = expectOk(res, (raw) => ({
          data: parseGmailMessage(raw as RawGmailMessage),
          rowsRead: 1,
        }));
        messages.push(data as ParsedGmailMessage);
      }
      return { data: { q, messages }, rowsRead: messages.length };
    },

    "email.create_draft": async (input, ctx) => {
      const config = gmailConfig.parse(ctx.config);
      const to = requireString(input, "to", "email.create_draft");
      const subject = requireString(input, "subject", "email.create_draft");
      const body = requireString(input, "body", "email.create_draft");
      const from = config.sendAsAddress ?? requireString(input, "from", "email.create_draft");

      const response = await ctx.http({
        url: `${GMAIL_BASE}/users/${encodeURIComponent(config.userId)}/drafts`,
        method: "POST",
        headers: bearer(ctx),
        body: {
          message: {
            raw: encodeMessage({
              to,
              from,
              subject,
              body,
              htmlBody: typeof input.htmlBody === "string" ? input.htmlBody : undefined,
              unsubscribeUrl:
                typeof input.unsubscribeUrl === "string" ? input.unsubscribeUrl : undefined,
            }),
          },
        },
      });
      const { data } = expectOk(response, (raw) => {
        const envelope = raw as { id?: string; message?: { id?: string; threadId?: string } } | null;
        return {
          data: {
            draftId: envelope?.id ?? "",
            messageId: envelope?.message?.id ?? null,
            threadId: envelope?.message?.threadId ?? null,
          },
          rowsWritten: 1,
        };
      });
      return { data, rowsWritten: 1 };
    },

    /**
     * The send path. Note it takes a `draftId` by preference: sending the exact
     * draft a human approved is materially safer than re-composing from fields
     * that may have changed since the approval.
     */
    "email.send_approved_message": async (input, ctx) => {
      const config = gmailConfig.parse(ctx.config);
      const draftId = typeof input.draftId === "string" ? input.draftId : "";

      if (draftId.length > 0) {
        const response = await ctx.http({
          url: `${GMAIL_BASE}/users/${encodeURIComponent(config.userId)}/drafts/send`,
          method: "POST",
          headers: bearer(ctx),
          body: { id: draftId },
        });
        const { data } = expectOk(response, (raw) => {
          const envelope = raw as { id?: string; threadId?: string } | null;
          return {
            data: { messageId: envelope?.id ?? "", threadId: envelope?.threadId ?? null, sentDraftId: draftId },
            rowsWritten: 1,
          };
        });
        return { data, rowsWritten: 1 };
      }

      const to = requireString(input, "to", "email.send_approved_message");
      const subject = requireString(input, "subject", "email.send_approved_message");
      const body = requireString(input, "body", "email.send_approved_message");
      const from = config.sendAsAddress ?? requireString(input, "from", "email.send_approved_message");
      const threadId = typeof input.threadId === "string" && input.threadId ? input.threadId : null;
      const response = await ctx.http({
        url: `${GMAIL_BASE}/users/${encodeURIComponent(config.userId)}/messages/send`,
        method: "POST",
        headers: bearer(ctx),
        body: {
          raw: encodeMessage({
            to,
            from,
            subject,
            body,
            htmlBody: typeof input.htmlBody === "string" ? input.htmlBody : undefined,
            unsubscribeUrl:
              typeof input.unsubscribeUrl === "string" ? input.unsubscribeUrl : undefined,
            inReplyTo: typeof input.inReplyTo === "string" ? input.inReplyTo : undefined,
            references: typeof input.references === "string" ? input.references : undefined,
            messageId: typeof input.messageId === "string" ? input.messageId : undefined,
          }),
          ...(threadId ? { threadId } : {}),
        },
      });
      const { data } = expectOk(response, (raw) => {
        const envelope = raw as { id?: string; threadId?: string } | null;
        return {
          data: { messageId: envelope?.id ?? "", threadId: envelope?.threadId ?? null },
          rowsWritten: 1,
        };
      });
      return { data, rowsWritten: 1 };
    },
  },
  probe: async (ctx) => {
    const config = gmailConfig.parse(ctx.config);
    const started = Date.now();
    const response = await ctx.http({
      url: `${GMAIL_BASE}/users/${encodeURIComponent(config.userId)}/profile`,
      headers: bearer(ctx),
    });
    return {
      authorizationOk: response.status !== 401 && response.status !== 403,
      readOk: response.ok,
      latencyMs: Date.now() - started,
      errorCode: response.ok ? null : `http_${response.status}`,
      errorMessage: response.ok ? null : response.text,
    };
  },
  refresh: googleRefresh,
});

// --------------------------------------------------------------- Calendar

const calendarConfig = z.object({
  calendarId: z.string().default("primary"),
  clientId: z.string().optional(),
  clientSecret: z.string().optional(),
});

const CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";

interface CalendarEventPayload {
  id?: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string; organizer?: boolean }[];
  organizer?: { email?: string };
}

function normalizeEvent(event: CalendarEventPayload) {
  return {
    id: event.id ?? "",
    title: event.summary ?? "",
    description: event.description ?? "",
    link: event.htmlLink ?? "",
    startsAt: event.start?.dateTime ?? event.start?.date ?? null,
    endsAt: event.end?.dateTime ?? event.end?.date ?? null,
    organizer: event.organizer?.email ?? "",
    attendees: (event.attendees ?? []).map((a) => ({
      email: a.email ?? "",
      name: a.displayName ?? "",
      responseStatus: a.responseStatus ?? "needsAction",
    })),
  };
}

export const googleCalendarConnector = buildAdapter({
  id: "google_calendar",
  provider: "google_calendar",
  version: "1.0.0",
  category: "calendar",
  status: "implemented_unverified",
  configSchema: calendarConfig,
  requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
  outstandingWork: [
    ...OUTSTANDING,
    "Recurring-event expansion relies on singleEvents=true; exceptions are untested.",
  ],
  handlers: {
    "calendar.fetch_events": async (input, ctx) => {
      const config = calendarConfig.parse(ctx.config);
      const timeMin = requireString(input, "timeMin", "calendar.fetch_events");
      const timeMax = requireString(input, "timeMax", "calendar.fetch_events");
      const params = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: String(typeof input.limit === "number" ? Math.min(input.limit, 250) : 50),
      });
      const response = await ctx.http({
        url: `${CALENDAR_BASE}/calendars/${encodeURIComponent(config.calendarId)}/events?${params.toString()}`,
        headers: bearer(ctx),
      });
      const { data } = expectOk(response, (raw) => {
        const envelope = raw as { items?: CalendarEventPayload[] } | null;
        const events = (envelope?.items ?? []).map(normalizeEvent);
        return { data: { events, period: { timeMin, timeMax } }, rowsRead: events.length };
      });
      return { data, rowsRead: (data as { events: unknown[] }).events.length };
    },

    "calendar.create_event": async (input, ctx) => {
      const config = calendarConfig.parse(ctx.config);
      const response = await ctx.http({
        url: `${CALENDAR_BASE}/calendars/${encodeURIComponent(config.calendarId)}/events`,
        method: "POST",
        headers: bearer(ctx),
        body: {
          summary: requireString(input, "title", "calendar.create_event"),
          description: typeof input.description === "string" ? input.description : "",
          start: { dateTime: requireString(input, "startsAt", "calendar.create_event") },
          end: { dateTime: requireString(input, "endsAt", "calendar.create_event") },
          attendees: Array.isArray(input.attendees)
            ? (input.attendees as string[]).map((email) => ({ email }))
            : [],
        },
      });
      const { data } = expectOk(response, (raw) => ({
        data: normalizeEvent((raw ?? {}) as CalendarEventPayload),
        rowsWritten: 1,
      }));
      return { data, rowsWritten: 1 };
    },

    "calendar.update_event": async (input, ctx) => {
      const config = calendarConfig.parse(ctx.config);
      const eventId = requireString(input, "eventId", "calendar.update_event");
      const patch: Record<string, unknown> = {};
      if (typeof input.title === "string") patch.summary = input.title;
      if (typeof input.description === "string") patch.description = input.description;
      if (typeof input.startsAt === "string") patch.start = { dateTime: input.startsAt };
      if (typeof input.endsAt === "string") patch.end = { dateTime: input.endsAt };

      const response = await ctx.http({
        url: `${CALENDAR_BASE}/calendars/${encodeURIComponent(config.calendarId)}/events/${encodeURIComponent(eventId)}`,
        method: "PATCH",
        headers: bearer(ctx),
        body: patch,
      });
      const { data } = expectOk(response, (raw) => ({
        data: normalizeEvent((raw ?? {}) as CalendarEventPayload),
        rowsWritten: 1,
      }));
      return { data, rowsWritten: 1 };
    },
  },
  probe: async (ctx) => {
    const config = calendarConfig.parse(ctx.config);
    const started = Date.now();
    const response = await ctx.http({
      url: `${CALENDAR_BASE}/calendars/${encodeURIComponent(config.calendarId)}`,
      headers: bearer(ctx),
    });
    return {
      authorizationOk: response.status !== 401 && response.status !== 403,
      readOk: response.ok,
      latencyMs: Date.now() - started,
      errorCode: response.ok ? null : `http_${response.status}`,
      errorMessage: response.ok ? null : response.text,
    };
  },
  refresh: googleRefresh,
});

/** Exported for the unit tests that assert the encoder's header behaviour. */
export const __testables = { encodeMessage, decodeBody, connectorFetch };
