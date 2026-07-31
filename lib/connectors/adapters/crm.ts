/**
 * CRM adapters: HubSpot, Follow Up Boss, Salesforce.
 *
 * STATUS: HubSpot and Follow Up Boss are `implemented_unverified` — written
 * against the documented HTTP contract, shape-tested against captured
 * fixtures, never executed live. Salesforce is `contract_only`: its config
 * validation and fixture mode work, but there is no live request path, because
 * doing Salesforce properly needs an instance URL, an OAuth flow and object
 * metadata discovery that would be guesswork without an org to test against.
 *
 * All three normalise to the same canonical contact/opportunity shape. That
 * normalisation is the reason a workflow can say `crm.fetch_contacts` and not
 * care which CRM the client runs.
 */
import { z } from "zod";
import {
  buildAdapter,
  expectOk,
  requireString,
  unverifiableHealth,
} from "@/lib/connectors/adapters/base";
import type { ConnectorContext } from "@/lib/connectors/types";

/** The canonical contact every CRM adapter must produce. */
export interface CanonicalContact {
  externalId: string;
  email: string;
  firstName: string;
  lastName: string;
  company: string;
  phone: string;
  lifecycleStage: string;
  owner: string;
  createdAt: string | null;
  /** Provider fields we did not map, kept so nothing is silently dropped. */
  unmapped: Record<string, unknown>;
}

export interface CanonicalOpportunity {
  externalId: string;
  name: string;
  stage: string;
  amountCents: number | null;
  currency: string;
  closeDate: string | null;
  owner: string;
  contactExternalId: string | null;
  unmapped: Record<string, unknown>;
}

/**
 * Money arrives from CRMs as strings, floats, or nothing. Cents are integers
 * here because float dollars are how a pipeline total ends up at 40234.999997
 * in a client report.
 */
export function toCents(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.\-]/g, ""));
  if (!Number.isFinite(numeric)) return null;
  return Math.round(numeric * 100);
}

// --------------------------------------------------------------- HubSpot

const hubspotConfig = z.object({
  /** Canonical → HubSpot property name overrides for non-standard portals. */
  propertyOverrides: z.record(z.string()).default({}),
  dealPipeline: z.string().optional(),
});

const HUBSPOT_BASE = "https://api.hubapi.com";

const HUBSPOT_CONTACT_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "company",
  "phone",
  "lifecyclestage",
  "hubspot_owner_id",
  "createdate",
];

const HUBSPOT_DEAL_PROPERTIES = [
  "dealname",
  "dealstage",
  "amount",
  "closedate",
  "hubspot_owner_id",
  "pipeline",
];

interface HubspotObject {
  id?: string;
  properties?: Record<string, unknown>;
  createdAt?: string;
}

function hubspotContact(object: HubspotObject): CanonicalContact {
  const properties = object.properties ?? {};
  const mapped = new Set(HUBSPOT_CONTACT_PROPERTIES);
  const unmapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!mapped.has(key)) unmapped[key] = value;
  }
  return {
    externalId: object.id ?? "",
    email: String(properties.email ?? ""),
    firstName: String(properties.firstname ?? ""),
    lastName: String(properties.lastname ?? ""),
    company: String(properties.company ?? ""),
    phone: String(properties.phone ?? ""),
    lifecycleStage: String(properties.lifecyclestage ?? ""),
    owner: String(properties.hubspot_owner_id ?? ""),
    createdAt: (properties.createdate as string | undefined) ?? object.createdAt ?? null,
    unmapped,
  };
}

function hubspotDeal(object: HubspotObject): CanonicalOpportunity {
  const properties = object.properties ?? {};
  const mapped = new Set(HUBSPOT_DEAL_PROPERTIES);
  const unmapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (!mapped.has(key)) unmapped[key] = value;
  }
  return {
    externalId: object.id ?? "",
    name: String(properties.dealname ?? ""),
    stage: String(properties.dealstage ?? ""),
    amountCents: toCents(properties.amount),
    currency: "USD",
    closeDate: (properties.closedate as string | undefined) ?? null,
    owner: String(properties.hubspot_owner_id ?? ""),
    contactExternalId: null,
    unmapped,
  };
}

function hubspotAuth(ctx: ConnectorContext): Record<string, string> {
  return { authorization: `Bearer ${ctx.secret()}` };
}

export const hubspotConnector = buildAdapter({
  id: "hubspot",
  provider: "hubspot",
  version: "1.0.0",
  category: "crm",
  status: "implemented_unverified",
  configSchema: hubspotConfig,
  requiredScopes: ["crm.objects.contacts.read", "crm.objects.contacts.write", "crm.objects.deals.read"],
  outstandingWork: [
    "Never executed against a live HubSpot portal — no credentials in this environment.",
    "Deal↔contact association is not fetched; contactExternalId is always null.",
    "Custom property discovery is manual via propertyOverrides.",
  ],
  handlers: {
    "crm.fetch_contacts": async (input, ctx) => {
      const limit = typeof input.limit === "number" ? Math.min(input.limit, 100) : 50;
      const params = new URLSearchParams({
        limit: String(limit),
        properties: HUBSPOT_CONTACT_PROPERTIES.join(","),
      });
      if (typeof input.after === "string") params.set("after", input.after);
      const response = await ctx.http({
        url: `${HUBSPOT_BASE}/crm/v3/objects/contacts?${params.toString()}`,
        headers: hubspotAuth(ctx),
      });
      const { data } = expectOk(response, (raw) => {
        const envelope = raw as
          | { results?: HubspotObject[]; paging?: { next?: { after?: string } } }
          | null;
        const contacts = (envelope?.results ?? []).map(hubspotContact);
        return {
          data: { contacts, nextCursor: envelope?.paging?.next?.after ?? null },
          rowsRead: contacts.length,
        };
      });
      return { data, rowsRead: (data as { contacts: unknown[] }).contacts.length };
    },

    "crm.create_contact": async (input, ctx) => {
      const email = requireString(input, "email", "crm.create_contact");
      const response = await ctx.http({
        url: `${HUBSPOT_BASE}/crm/v3/objects/contacts`,
        method: "POST",
        headers: hubspotAuth(ctx),
        body: {
          properties: {
            email,
            firstname: String(input.firstName ?? ""),
            lastname: String(input.lastName ?? ""),
            company: String(input.company ?? ""),
            phone: String(input.phone ?? ""),
            ...(typeof input.properties === "object" && input.properties !== null
              ? (input.properties as Record<string, unknown>)
              : {}),
          },
        },
      });
      const { data } = expectOk(response, (raw) => ({
        data: hubspotContact((raw ?? {}) as HubspotObject),
        rowsWritten: 1,
      }));
      return { data, rowsWritten: 1 };
    },

    "crm.update_contact": async (input, ctx) => {
      const externalId = requireString(input, "externalId", "crm.update_contact");
      const response = await ctx.http({
        url: `${HUBSPOT_BASE}/crm/v3/objects/contacts/${encodeURIComponent(externalId)}`,
        method: "PATCH",
        headers: hubspotAuth(ctx),
        body: {
          properties:
            typeof input.properties === "object" && input.properties !== null
              ? (input.properties as Record<string, unknown>)
              : {},
        },
      });
      const { data } = expectOk(response, (raw) => ({
        data: hubspotContact((raw ?? {}) as HubspotObject),
        rowsWritten: 1,
      }));
      return { data, rowsWritten: 1 };
    },

    "crm.fetch_opportunities": async (input, ctx) => {
      const limit = typeof input.limit === "number" ? Math.min(input.limit, 100) : 50;
      const params = new URLSearchParams({
        limit: String(limit),
        properties: HUBSPOT_DEAL_PROPERTIES.join(","),
      });
      if (typeof input.after === "string") params.set("after", input.after);
      const response = await ctx.http({
        url: `${HUBSPOT_BASE}/crm/v3/objects/deals?${params.toString()}`,
        headers: hubspotAuth(ctx),
      });
      const { data } = expectOk(response, (raw) => {
        const envelope = raw as
          | { results?: HubspotObject[]; paging?: { next?: { after?: string } } }
          | null;
        const opportunities = (envelope?.results ?? []).map(hubspotDeal);
        return {
          data: { opportunities, nextCursor: envelope?.paging?.next?.after ?? null },
          rowsRead: opportunities.length,
        };
      });
      return { data, rowsRead: (data as { opportunities: unknown[] }).opportunities.length };
    },

    "crm.update_opportunity": async (input, ctx) => {
      const externalId = requireString(input, "externalId", "crm.update_opportunity");
      const properties: Record<string, unknown> = {};
      if (typeof input.stage === "string") properties.dealstage = input.stage;
      if (typeof input.amountCents === "number") properties.amount = input.amountCents / 100;
      if (typeof input.closeDate === "string") properties.closedate = input.closeDate;
      const response = await ctx.http({
        url: `${HUBSPOT_BASE}/crm/v3/objects/deals/${encodeURIComponent(externalId)}`,
        method: "PATCH",
        headers: hubspotAuth(ctx),
        body: { properties },
      });
      const { data } = expectOk(response, (raw) => ({
        data: hubspotDeal((raw ?? {}) as HubspotObject),
        rowsWritten: 1,
      }));
      return { data, rowsWritten: 1 };
    },

    "crm.fetch_stage_history": async (input, ctx) => {
      const externalId = requireString(input, "externalId", "crm.fetch_stage_history");
      const response = await ctx.http({
        url: `${HUBSPOT_BASE}/crm/v3/objects/deals/${encodeURIComponent(externalId)}?propertiesWithHistory=dealstage`,
        headers: hubspotAuth(ctx),
      });
      const { data } = expectOk(response, (raw) => {
        const envelope = raw as
          | {
              propertiesWithHistory?: {
                dealstage?: { value?: string; timestamp?: string; sourceType?: string }[];
              };
            }
          | null;
        const history = (envelope?.propertiesWithHistory?.dealstage ?? []).map((entry) => ({
          stage: entry.value ?? "",
          changedAt: entry.timestamp ?? null,
          source: entry.sourceType ?? "",
        }));
        return { data: { externalId, history }, rowsRead: history.length };
      });
      return { data, rowsRead: (data as { history: unknown[] }).history.length };
    },
  },
  probe: async (ctx) => {
    const started = Date.now();
    const response = await ctx.http({
      url: `${HUBSPOT_BASE}/crm/v3/objects/contacts?limit=1`,
      headers: hubspotAuth(ctx),
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

// --------------------------------------------------------- Follow Up Boss

const fubConfig = z.object({
  /** FUB custom field holding estimated commission, per the mapping layer. */
  commissionField: z.string().default("customEstimatedCommission"),
});

const FUB_BASE = "https://api.followupboss.com/v1";

interface FubPerson {
  id?: number;
  firstName?: string;
  lastName?: string;
  emails?: { value?: string }[];
  phones?: { value?: string }[];
  stage?: string;
  assignedTo?: string;
  created?: string;
  [key: string]: unknown;
}

/** Follow Up Boss uses HTTP Basic with the API key as the username. */
function fubAuth(ctx: ConnectorContext): Record<string, string> {
  return {
    authorization: `Basic ${Buffer.from(`${ctx.secret()}:`).toString("base64")}`,
  };
}

function fubContact(person: FubPerson): CanonicalContact {
  const known = new Set([
    "id",
    "firstName",
    "lastName",
    "emails",
    "phones",
    "stage",
    "assignedTo",
    "created",
  ]);
  const unmapped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(person)) {
    if (!known.has(key)) unmapped[key] = value;
  }
  return {
    externalId: person.id === undefined ? "" : String(person.id),
    email: person.emails?.[0]?.value ?? "",
    firstName: person.firstName ?? "",
    lastName: person.lastName ?? "",
    company: "",
    phone: person.phones?.[0]?.value ?? "",
    lifecycleStage: person.stage ?? "",
    owner: person.assignedTo ?? "",
    createdAt: person.created ?? null,
    unmapped,
  };
}

export const followUpBossConnector = buildAdapter({
  id: "follow_up_boss",
  provider: "follow_up_boss",
  version: "1.0.0",
  category: "crm",
  status: "implemented_unverified",
  configSchema: fubConfig,
  requiredScopes: [],
  outstandingWork: [
    "Never executed against a live Follow Up Boss account.",
    "Deal/opportunity endpoints vary by plan tier; only /people and /deals are implemented.",
  ],
  handlers: {
    "crm.fetch_contacts": async (input, ctx) => {
      const params = new URLSearchParams({
        limit: String(typeof input.limit === "number" ? Math.min(input.limit, 100) : 50),
      });
      if (typeof input.offset === "number") params.set("offset", String(input.offset));
      const response = await ctx.http({
        url: `${FUB_BASE}/people?${params.toString()}`,
        headers: fubAuth(ctx),
      });
      const { data } = expectOk(response, (raw) => {
        const envelope = raw as { people?: FubPerson[]; _metadata?: { next?: string } } | null;
        const contacts = (envelope?.people ?? []).map(fubContact);
        return {
          data: { contacts, nextCursor: envelope?._metadata?.next ?? null },
          rowsRead: contacts.length,
        };
      });
      return { data, rowsRead: (data as { contacts: unknown[] }).contacts.length };
    },

    "crm.create_contact": async (input, ctx) => {
      const email = requireString(input, "email", "crm.create_contact");
      const response = await ctx.http({
        url: `${FUB_BASE}/people`,
        method: "POST",
        headers: fubAuth(ctx),
        body: {
          firstName: String(input.firstName ?? ""),
          lastName: String(input.lastName ?? ""),
          emails: [{ value: email }],
          ...(typeof input.phone === "string" ? { phones: [{ value: input.phone }] } : {}),
        },
      });
      const { data } = expectOk(response, (raw) => ({
        data: fubContact((raw ?? {}) as FubPerson),
        rowsWritten: 1,
      }));
      return { data, rowsWritten: 1 };
    },

    "crm.update_contact": async (input, ctx) => {
      const externalId = requireString(input, "externalId", "crm.update_contact");
      const response = await ctx.http({
        url: `${FUB_BASE}/people/${encodeURIComponent(externalId)}`,
        method: "PUT",
        headers: fubAuth(ctx),
        body:
          typeof input.properties === "object" && input.properties !== null
            ? (input.properties as Record<string, unknown>)
            : {},
      });
      const { data } = expectOk(response, (raw) => ({
        data: fubContact((raw ?? {}) as FubPerson),
        rowsWritten: 1,
      }));
      return { data, rowsWritten: 1 };
    },

    "crm.fetch_opportunities": async (input, ctx) => {
      const config = fubConfig.parse(ctx.config);
      const params = new URLSearchParams({
        limit: String(typeof input.limit === "number" ? Math.min(input.limit, 100) : 50),
      });
      const response = await ctx.http({
        url: `${FUB_BASE}/deals?${params.toString()}`,
        headers: fubAuth(ctx),
      });
      const { data } = expectOk(response, (raw) => {
        const envelope = raw as
          | { deals?: (Record<string, unknown> & { id?: number; name?: string; stage?: string })[] }
          | null;
        const opportunities: CanonicalOpportunity[] = (envelope?.deals ?? []).map((deal) => ({
          externalId: deal.id === undefined ? "" : String(deal.id),
          name: String(deal.name ?? ""),
          stage: String(deal.stage ?? ""),
          amountCents: toCents(deal[config.commissionField] ?? deal.price),
          currency: "USD",
          closeDate: (deal.closeDate as string | undefined) ?? null,
          owner: String(deal.assignedTo ?? ""),
          contactExternalId: deal.personId === undefined ? null : String(deal.personId),
          unmapped: {},
        }));
        return { data: { opportunities, nextCursor: null }, rowsRead: opportunities.length };
      });
      return { data, rowsRead: (data as { opportunities: unknown[] }).opportunities.length };
    },

    "crm.update_opportunity": async (input, ctx) => {
      const externalId = requireString(input, "externalId", "crm.update_opportunity");
      const body: Record<string, unknown> = {};
      if (typeof input.stage === "string") body.stage = input.stage;
      if (typeof input.amountCents === "number") body.price = input.amountCents / 100;
      const response = await ctx.http({
        url: `${FUB_BASE}/deals/${encodeURIComponent(externalId)}`,
        method: "PUT",
        headers: fubAuth(ctx),
        body,
      });
      const { data } = expectOk(response, (raw) => ({
        data: { externalId, updated: true, provider: raw ?? null },
        rowsWritten: 1,
      }));
      return { data, rowsWritten: 1 };
    },
  },
  probe: async (ctx) => {
    const started = Date.now();
    const response = await ctx.http({
      url: `${FUB_BASE}/identity`,
      headers: fubAuth(ctx),
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

// ------------------------------------------------------------- Salesforce

const salesforceConfig = z.object({
  instanceUrl: z.string().url("Salesforce instanceUrl must be a URL"),
  apiVersion: z.string().default("v60.0"),
});

/**
 * `contract_only`. Config validation and fixture mode work, so a workflow can
 * be authored and tested against Salesforce today. There is no live request
 * path: doing Salesforce correctly needs object-metadata discovery against a
 * real org, and guessing at field names would be exactly the "pretending an
 * integration works" this spec forbids.
 */
export const salesforceConnector = buildAdapter({
  id: "salesforce",
  provider: "salesforce",
  version: "0.1.0",
  category: "crm",
  status: "contract_only",
  configSchema: salesforceConfig,
  requiredScopes: ["api", "refresh_token"],
  outstandingWork: [
    "No live request path. Contract, config validation and fixture mode only.",
    "Needs SObject metadata discovery to map custom fields safely.",
    "Needs the OAuth JWT-bearer or web-server flow before it can authenticate.",
  ],
  handlers: {
    // Registered so the capability appears as declared-but-unavailable rather
    // than silently missing. Live mode returns an honest failure.
    "crm.fetch_contacts": async () => {
      throw new Error(
        "Salesforce adapter is contract_only: no live request path is implemented. Use fixture mode or another CRM."
      );
    },
    "crm.fetch_opportunities": async () => {
      throw new Error(
        "Salesforce adapter is contract_only: no live request path is implemented. Use fixture mode or another CRM."
      );
    },
  },
  probe: async () =>
    unverifiableHealth(
      "Salesforce adapter is contract_only — there is no live probe to run."
    ),
});
