/**
 * The connector contract (spec: connector-sdk).
 *
 * The workflow layer names a **capability**; it never names a provider. That is
 * the whole point: swapping HubSpot for Follow Up Boss is a connection change,
 * not a code change, and no feature module ever imports a vendor SDK.
 *
 * Note what `ConnectorExecutionContext` does not carry: no `sql`, no
 * connection row, no token string. It carries a `secret()` accessor that is a
 * closure over one call's decrypted value. There is no path from an adapter to
 * the credential store, and none from a node handler to either.
 */
import type { z } from "zod";

export const CONNECTOR_CAPABILITIES = [
  "analytics.fetch_sessions",
  "analytics.fetch_events",
  "analytics.fetch_landing_pages",
  "analytics.fetch_referrals",

  "search_console.fetch_queries",
  "search_console.fetch_pages",

  "crm.fetch_contacts",
  "crm.create_contact",
  "crm.update_contact",
  "crm.fetch_opportunities",
  "crm.update_opportunity",
  "crm.fetch_stage_history",

  "email.read_thread",
  "email.search_messages",
  "email.create_draft",
  "email.send_approved_message",

  "calendar.fetch_events",
  "calendar.create_event",
  "calendar.update_event",

  "cms.create_draft",
  "cms.update_draft",
  "cms.publish_approved_asset",
  "cms.fetch_public_page",

  "billing.create_invoice",
  "billing.fetch_invoice",
  "billing.send_reminder",
  "billing.fetch_payment_status",

  "notification.send_internal",
  "notification.send_client",

  "file.store",
  "file.retrieve",
] as const;
export type ConnectorCapability = (typeof CONNECTOR_CAPABILITIES)[number];

export const CONNECTOR_CATEGORIES = [
  "analytics",
  "search_console",
  "crm",
  "email",
  "calendar",
  "cms",
  "billing",
  "notification",
  "storage",
  "ingestion",
  "testing",
] as const;
export type ConnectorCategory = (typeof CONNECTOR_CATEGORIES)[number];

/**
 * Honest status labelling. The request was explicit: do not pretend an
 * integration works.
 *
 *  - `verified`               — exercised end to end in this repository.
 *  - `implemented_unverified` — written against the provider's documented HTTP
 *                              contract, request/response shapes tested against
 *                              captured fixtures, never run against the live API
 *                              (no credentials exist in this environment).
 *  - `contract_only`          — interface, config validation and fixture mode
 *                              exist; there is no live request path.
 */
export type ConnectorStatus = "verified" | "implemented_unverified" | "contract_only";

/**
 * Capabilities that have an irreversible effect outside the platform. Test mode
 * refuses these outright; live mode requires a satisfied approval.
 */
export const CONSEQUENTIAL_CAPABILITIES: readonly ConnectorCapability[] = [
  "email.send_approved_message",
  "cms.publish_approved_asset",
  "billing.create_invoice",
  "billing.send_reminder",
  "notification.send_client",
];

/**
 * Capabilities that mutate an external record without contacting a human.
 * Blocked in test mode unless the run explicitly opts in.
 */
export const MUTATING_CAPABILITIES: readonly ConnectorCapability[] = [
  "crm.create_contact",
  "crm.update_contact",
  "crm.update_opportunity",
  "email.create_draft",
  "calendar.create_event",
  "calendar.update_event",
  "cms.create_draft",
  "cms.update_draft",
  "file.store",
];

export function isConsequential(capability: ConnectorCapability): boolean {
  return CONSEQUENTIAL_CAPABILITIES.includes(capability);
}

export function isMutating(capability: ConnectorCapability): boolean {
  return MUTATING_CAPABILITIES.includes(capability) || isConsequential(capability);
}

// ----------------------------------------------------------------- contexts

export type ExecutionMode = "live" | "fixture";

export interface ConnectorHttpRequest {
  url: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  /** Form-encoded body, for providers that require it. */
  form?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Return response `data` WITHOUT secret redaction. STRICTLY for token
   * refresh calls whose entire purpose is receiving a credential that goes
   * straight into the encrypted store: the default redaction turned every
   * refreshed access_token into the literal string "[redacted]", which was
   * then stored and sent to the provider — every oauth2 connector died one
   * hour after connecting (found live, first outreach batch 2026-08-20).
   * `text` stays redacted regardless.
   */
  rawSecrets?: boolean;
}

export interface ConnectorHttpResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T | null;
  /** Raw text, truncated and redacted. Present for diagnostics only. */
  text: string;
  headers: Record<string, string>;
  latencyMs: number;
  rateLimited: boolean;
  retryAfterSeconds: number | null;
}

export interface ConnectorContext {
  connectionId: string;
  projectId: string | null;
  provider: string;
  mode: ExecutionMode;
  config: Record<string, unknown>;
  /** The connector's own scopes, so an adapter can refuse before calling out. */
  grantedScopes: string[];
  /** One call's decrypted secret. Not stored, not returned, not serialisable. */
  secret: () => string;
  /** Refresh token accessor, when the connection has one. */
  refreshSecret: () => string | null;
  http: (request: ConnectorHttpRequest) => Promise<ConnectorHttpResponse>;
  /** Canned responses, keyed by capability, for fixture mode and test runs. */
  fixtures: Record<string, unknown>;
}

export interface ConnectorExecutionContext extends ConnectorContext {
  capability: ConnectorCapability;
  workflowRunId: string | null;
  nodeRunId: string | null;
}

// ------------------------------------------------------------------ results

export interface ConfigurationValidationResult {
  valid: boolean;
  errors: string[];
  /** Config with defaults applied, when valid. */
  normalized?: Record<string, unknown>;
}

export interface ConnectionHealthResult {
  authorizationOk: boolean;
  readOk: boolean;
  latencyMs: number;
  errorCode: string | null;
  errorMessage: string | null;
  /** Scopes the provider says we actually have, when it tells us. */
  observedScopes?: string[];
  expiresAt?: Date | null;
}

export interface ConnectorExecutionResult<TOutput = unknown> {
  ok: boolean;
  data: TOutput | null;
  error: string | null;
  errorCode: string | null;
  statusCode: number | null;
  retryable: boolean;
  rateLimited: boolean;
  retryAfterSeconds: number | null;
  latencyMs: number;
  rowsRead: number;
  rowsWritten: number;
  /** Always true: every result has passed through redaction. */
  redacted: true;
  /** Provider's request id, when it gives one — for support conversations. */
  requestId: string | null;
}

export interface AuthorizationRefreshResult {
  refreshed: boolean;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date | null;
  error?: string;
}

// ---------------------------------------------------------------- connector

export interface Connector<TConfig = unknown> {
  id: string;
  provider: string;
  version: string;
  category: ConnectorCategory;
  status: ConnectorStatus;
  capabilities: ConnectorCapability[];
  configSchema: z.ZodType<TConfig, z.ZodTypeDef, unknown>;
  /** Scopes this connector needs; shown in the UI before a connection is made. */
  requiredScopes: string[];
  /** What remains before this adapter could be called production-ready. */
  outstandingWork: string[];

  validateConfiguration(config: unknown): Promise<ConfigurationValidationResult>;
  testConnection(ctx: ConnectorContext): Promise<ConnectionHealthResult>;
  execute<TInput, TOutput>(
    capability: ConnectorCapability,
    input: TInput,
    ctx: ConnectorExecutionContext
  ): Promise<ConnectorExecutionResult<TOutput>>;
  refreshAuthorization?(ctx: ConnectorContext): Promise<AuthorizationRefreshResult>;
  revoke?(ctx: ConnectorContext): Promise<void>;
}

// -------------------------------------------------------------- connections

export type ConnectionStatus =
  | "pending"
  | "active"
  | "degraded"
  | "authorization_expired"
  | "revoked";

export interface ConnectorConnection {
  id: string;
  projectId: string | null;
  provider: string;
  connectionName: string;
  externalAccountId: string;
  status: ConnectionStatus;
  grantedScopes: string[];
  config: Record<string, unknown>;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastSyncAt: Date | null;
  lastError: string | null;
  expiresAt: Date | null;
  createdBy: string | null;
  revokedAt: Date | null;
}

export type CredentialKind = "oauth2" | "api_key" | "basic" | "hmac_secret";

/** Days before expiry at which a connection is flagged for renewal. */
export const EXPIRY_WARNING_DAYS = 14;

/** A helper that builds an unambiguous failure result. */
export function executionFailure<T>(args: {
  error: string;
  errorCode?: string | null;
  statusCode?: number | null;
  retryable?: boolean;
  rateLimited?: boolean;
  retryAfterSeconds?: number | null;
  latencyMs?: number;
}): ConnectorExecutionResult<T> {
  return {
    ok: false,
    data: null,
    error: args.error,
    errorCode: args.errorCode ?? null,
    statusCode: args.statusCode ?? null,
    retryable: args.retryable ?? false,
    rateLimited: args.rateLimited ?? false,
    retryAfterSeconds: args.retryAfterSeconds ?? null,
    latencyMs: args.latencyMs ?? 0,
    rowsRead: 0,
    rowsWritten: 0,
    redacted: true,
    requestId: null,
  };
}

export function executionSuccess<T>(args: {
  data: T;
  latencyMs?: number;
  rowsRead?: number;
  rowsWritten?: number;
  requestId?: string | null;
}): ConnectorExecutionResult<T> {
  return {
    ok: true,
    data: args.data,
    error: null,
    errorCode: null,
    statusCode: 200,
    retryable: false,
    rateLimited: false,
    retryAfterSeconds: null,
    latencyMs: args.latencyMs ?? 0,
    rowsRead: args.rowsRead ?? 0,
    rowsWritten: args.rowsWritten ?? 0,
    redacted: true,
    requestId: args.requestId ?? null,
  };
}
