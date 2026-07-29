/**
 * Shared adapter scaffolding.
 *
 * Every adapter is "a set of capability handlers plus a config schema", so the
 * repetitive parts — config validation, capability dispatch, fixture mode,
 * error classification, redaction — live here once. An adapter file then
 * contains only what is genuinely provider-specific, which is the point of
 * having a connector layer at all.
 */
import type { z } from "zod";
import { redactSecrets, redactString } from "@/lib/security/envelope";
import {
  executionFailure,
  executionSuccess,
  type ConfigurationValidationResult,
  type Connector,
  type ConnectorCapability,
  type ConnectorCategory,
  type ConnectorExecutionContext,
  type ConnectorExecutionResult,
  type ConnectorHttpResponse,
  type ConnectionHealthResult,
  type ConnectorStatus,
  type ConnectorContext,
  type AuthorizationRefreshResult,
} from "@/lib/connectors/types";

export interface CapabilityHandlerResult {
  data: unknown;
  rowsRead?: number;
  rowsWritten?: number;
  requestId?: string | null;
}

export type CapabilityHandler = (
  input: Record<string, unknown>,
  ctx: ConnectorExecutionContext
) => Promise<CapabilityHandlerResult>;

export interface AdapterSpec<TConfig> {
  id: string;
  provider: string;
  version: string;
  category: ConnectorCategory;
  status: ConnectorStatus;
  configSchema: z.ZodType<TConfig, z.ZodTypeDef, unknown>;
  requiredScopes?: string[];
  outstandingWork?: string[];
  handlers: Partial<Record<ConnectorCapability, CapabilityHandler>>;
  /** Health probe. Defaults to "we cannot verify without a live call". */
  probe?: (ctx: ConnectorContext) => Promise<ConnectionHealthResult>;
  refresh?: (ctx: ConnectorContext) => Promise<AuthorizationRefreshResult>;
  revoke?: (ctx: ConnectorContext) => Promise<void>;
}

/**
 * Classify a provider HTTP response into a connector result. Retryability is
 * decided here so no adapter has to remember that 429 and 5xx are retryable
 * while 400 and 403 are not.
 */
export function fromHttp<T>(
  response: ConnectorHttpResponse,
  extract: (data: unknown) => { data: T; rowsRead?: number; rowsWritten?: number }
): ConnectorExecutionResult<T> {
  if (response.ok) {
    try {
      const extracted = extract(response.data);
      return executionSuccess({
        data: extracted.data,
        latencyMs: response.latencyMs,
        rowsRead: extracted.rowsRead ?? 0,
        rowsWritten: extracted.rowsWritten ?? 0,
        requestId: response.headers["x-request-id"] ?? null,
      });
    } catch (err) {
      // A 200 whose body we cannot understand is a failure, not a success with
      // empty data — silently returning nothing is how a report loses a metric.
      return executionFailure<T>({
        error: `Provider returned an unexpected response shape: ${
          err instanceof Error ? err.message : "unparseable"
        }`,
        errorCode: "malformed_response",
        statusCode: response.status,
        retryable: false,
        latencyMs: response.latencyMs,
      });
    }
  }

  const authFailure = response.status === 401 || response.status === 403;
  return executionFailure<T>({
    error: response.text.length > 0 ? response.text : `provider returned ${response.status}`,
    errorCode: authFailure
      ? "authorization_failed"
      : response.rateLimited
        ? "rate_limited"
        : response.status === 408 || response.status === 0
          ? "timeout"
          : `http_${response.status}`,
    statusCode: response.status,
    retryable: response.rateLimited || response.status >= 500 || response.status === 408,
    rateLimited: response.rateLimited,
    retryAfterSeconds: response.retryAfterSeconds,
    latencyMs: response.latencyMs,
  });
}

/** The health result a `contract_only` adapter honestly returns. */
export function unverifiableHealth(reason: string): ConnectionHealthResult {
  return {
    authorizationOk: false,
    readOk: false,
    latencyMs: 0,
    errorCode: "not_implemented",
    errorMessage: reason,
  };
}

export function buildAdapter<TConfig>(spec: AdapterSpec<TConfig>): Connector<TConfig> {
  const capabilities = Object.keys(spec.handlers) as ConnectorCapability[];

  return {
    id: spec.id,
    provider: spec.provider,
    version: spec.version,
    category: spec.category,
    status: spec.status,
    capabilities,
    configSchema: spec.configSchema,
    requiredScopes: spec.requiredScopes ?? [],
    outstandingWork: spec.outstandingWork ?? [],

    async validateConfiguration(config: unknown): Promise<ConfigurationValidationResult> {
      const parsed = spec.configSchema.safeParse(config ?? {});
      if (!parsed.success) {
        return {
          valid: false,
          errors: parsed.error.issues.map((i) =>
            i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message
          ),
        };
      }
      return {
        valid: true,
        errors: [],
        normalized: parsed.data as Record<string, unknown>,
      };
    },

    async testConnection(ctx: ConnectorContext): Promise<ConnectionHealthResult> {
      if (ctx.mode === "fixture") {
        return {
          authorizationOk: true,
          readOk: true,
          latencyMs: 0,
          errorCode: null,
          errorMessage: null,
        };
      }
      if (!spec.probe) {
        return unverifiableHealth(
          `${spec.provider} has no live health probe implemented (status: ${spec.status}).`
        );
      }
      try {
        return await spec.probe(ctx);
      } catch (err) {
        return {
          authorizationOk: false,
          readOk: false,
          latencyMs: 0,
          errorCode: "probe_failed",
          errorMessage: redactString(err instanceof Error ? err.message : String(err)),
        };
      }
    },

    async execute<TInput, TOutput>(
      capability: ConnectorCapability,
      input: TInput,
      ctx: ConnectorExecutionContext
    ): Promise<ConnectorExecutionResult<TOutput>> {
      // Fixture mode short-circuits before any handler runs. A test run must
      // not depend on an adapter remembering to check the mode.
      if (ctx.mode === "fixture") {
        const canned = ctx.fixtures[capability];
        if (canned === undefined) {
          return executionFailure<TOutput>({
            error: `No fixture provided for "${capability}" on ${spec.provider}. Add one to the workflow fixture.`,
            errorCode: "fixture_missing",
            retryable: false,
          });
        }
        return executionSuccess<TOutput>({
          data: redactSecrets(canned) as TOutput,
          rowsRead: Array.isArray(canned) ? canned.length : 1,
        });
      }

      const handler = spec.handlers[capability];
      if (!handler) {
        return executionFailure<TOutput>({
          error: `${spec.provider} does not support "${capability}".`,
          errorCode: "unsupported_capability",
          retryable: false,
        });
      }

      const started = Date.now();
      try {
        const result = await handler((input ?? {}) as Record<string, unknown>, ctx);
        return executionSuccess<TOutput>({
          data: redactSecrets(result.data) as TOutput,
          latencyMs: Date.now() - started,
          rowsRead: result.rowsRead ?? 0,
          rowsWritten: result.rowsWritten ?? 0,
          requestId: result.requestId ?? null,
        });
      } catch (err) {
        // A handler may throw an already-classified result to preserve the
        // provider's status code and retryability.
        if (isResultCarrier(err)) return err.result as ConnectorExecutionResult<TOutput>;
        return executionFailure<TOutput>({
          error: redactString(err instanceof Error ? err.message : String(err)),
          errorCode: "adapter_error",
          retryable: false,
          latencyMs: Date.now() - started,
        });
      }
    },

    ...(spec.refresh ? { refreshAuthorization: spec.refresh } : {}),
    ...(spec.revoke ? { revoke: spec.revoke } : {}),
  };
}

// ------------------------------------------------------ throwing a result

class ResultCarrier extends Error {
  readonly result: ConnectorExecutionResult<unknown>;
  constructor(result: ConnectorExecutionResult<unknown>) {
    super(result.error ?? "connector failure");
    this.name = "ConnectorResultCarrier";
    this.result = result;
  }
}

function isResultCarrier(err: unknown): err is ResultCarrier {
  return err instanceof ResultCarrier;
}

/**
 * Abort a capability handler while preserving the classified result. Used when
 * a handler makes several calls and one of them fails in a way the caller must
 * see accurately (auth vs rate limit vs 500).
 */
export function abortWith(result: ConnectorExecutionResult<unknown>): never {
  throw new ResultCarrier(result);
}

/** Unwrap an HTTP response or abort with its classified failure. */
export function expectOk<T>(
  response: ConnectorHttpResponse,
  extract: (data: unknown) => { data: T; rowsRead?: number; rowsWritten?: number }
): { data: T; rowsRead?: number; rowsWritten?: number } {
  const classified = fromHttp(response, extract);
  if (!classified.ok) abortWith(classified);
  return {
    data: classified.data as T,
    rowsRead: classified.rowsRead,
    rowsWritten: classified.rowsWritten,
  };
}

/** Read a required string from a capability input, or fail clearly. */
export function requireString(
  input: Record<string, unknown>,
  key: string,
  capability: string
): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0) {
    abortWith(
      executionFailure({
        error: `"${capability}" requires a non-empty "${key}".`,
        errorCode: "invalid_input",
        retryable: false,
      })
    );
  }
  return value as string;
}
