/**
 * Connection health. The point is preventing *silent* failure: a connector that
 * stopped working three weeks ago and nobody noticed has already corrupted a
 * month of reporting.
 *
 * A health check records two independent facts — can we authenticate, and can
 * we read — because they fail for different reasons and need different fixes.
 */
import { sql } from "@/db/client";
import * as store from "@/db/connectors";
import { connectorFetch, type FetchLike } from "@/lib/connectors/http";
import { getConnector } from "@/lib/connectors/registry";
import { resolveSecrets } from "@/lib/connectors/credentials";
import { EXPIRY_WARNING_DAYS, type ConnectorConnection } from "@/lib/connectors/types";
import { redactString } from "@/lib/security/envelope";
import { raiseException } from "@/lib/workflow/exceptions";
import { log } from "@/lib/logger";

export interface HealthCheckOutcome {
  connectionId: string;
  provider: string;
  authorizationOk: boolean;
  readOk: boolean;
  latencyMs: number;
  severity: "low" | "medium" | "high" | "critical";
  errorCode: string | null;
  errorMessage: string | null;
  /** Days until the authorisation expires; null when it does not. */
  daysUntilExpiry: number | null;
  statusAfter: ConnectorConnection["status"];
}

/**
 * Severity is a function of what broke and who it affects. An expired
 * authorisation on a client's analytics connection is worse than a slow read on
 * an internal Slack, and the operator queue should say so.
 */
function severityFor(args: {
  authorizationOk: boolean;
  readOk: boolean;
  clientScoped: boolean;
  daysUntilExpiry: number | null;
}): "low" | "medium" | "high" | "critical" {
  if (!args.authorizationOk) return args.clientScoped ? "critical" : "high";
  if (!args.readOk) return args.clientScoped ? "high" : "medium";
  if (args.daysUntilExpiry !== null && args.daysUntilExpiry <= 3) return "high";
  if (args.daysUntilExpiry !== null && args.daysUntilExpiry <= EXPIRY_WARNING_DAYS) return "medium";
  return "low";
}

export async function checkConnection(
  connectionId: string,
  options?: { fetchImpl?: FetchLike; raiseExceptions?: boolean }
): Promise<HealthCheckOutcome> {
  const connection = await store.getConnection(connectionId);
  if (!connection) {
    throw new Error(`Connection ${connectionId} not found.`);
  }
  const connector = getConnector(connection.provider);

  let authorizationOk = false;
  let readOk = false;
  let latencyMs = 0;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  try {
    const secrets = await resolveSecrets(connection.id);
    const result = await connector.testConnection({
      connectionId: connection.id,
      projectId: connection.projectId,
      provider: connection.provider,
      mode: "live",
      config: connection.config,
      grantedScopes: connection.grantedScopes,
      secret: () => secrets.accessToken,
      refreshSecret: () => secrets.refreshToken,
      http: (request) =>
        connectorFetch(request, {
          provider: connection.provider,
          capability: "health",
          fetchImpl: options?.fetchImpl,
        }),
      fixtures: {},
    });
    authorizationOk = result.authorizationOk;
    readOk = result.readOk;
    latencyMs = result.latencyMs;
    errorCode = result.errorCode;
    errorMessage = result.errorMessage === null ? null : redactString(result.errorMessage);
  } catch (err) {
    errorCode = "credential_unavailable";
    errorMessage = redactString(err instanceof Error ? err.message : String(err));
  }

  const daysUntilExpiry =
    connection.expiresAt === null
      ? null
      : Math.floor((connection.expiresAt.getTime() - Date.now()) / 86_400_000);

  const severity = severityFor({
    authorizationOk,
    readOk,
    clientScoped: connection.projectId !== null,
    daysUntilExpiry,
  });

  const statusAfter: ConnectorConnection["status"] = !authorizationOk
    ? "authorization_expired"
    : readOk
      ? "active"
      : "degraded";

  await sql.begin(async (tx) => {
    await store.insertHealthCheck(tx, {
      connectionId: connection.id,
      projectId: connection.projectId,
      authorizationOk,
      readOk,
      latencyMs,
      errorCode,
      errorMessage: errorMessage === null ? null : errorMessage.slice(0, 500),
      severity,
      detail: {
        adapterStatus: connector.status,
        daysUntilExpiry,
        outstandingWork: connector.outstandingWork,
      },
    });
    await store.recordTestResult(tx, {
      connectionId: connection.id,
      ok: authorizationOk && readOk,
      error: errorMessage,
    });
    await store.setConnectionStatus(tx, {
      connectionId: connection.id,
      status: statusAfter,
      lastError: errorMessage,
    });

    if (options?.raiseExceptions !== false && (!authorizationOk || !readOk)) {
      await raiseException(tx, {
        projectId: connection.projectId,
        kind: "failed_integration",
        severity,
        summary: !authorizationOk
          ? `${connection.provider} authorisation failed${connection.projectId ? " for this client" : ""}: ${errorMessage ?? errorCode ?? "unknown"}`
          : `${connection.provider} authenticated but could not read: ${errorMessage ?? errorCode ?? "unknown"}`,
        detail: { errorCode, adapterStatus: connector.status },
        recommendedAction: !authorizationOk
          ? "Reconnect the provider. Reporting that depends on it will be incomplete until then, and must say so."
          : "Check the provider's permissions and the configured property/site id.",
      });
    }
  });

  log(authorizationOk && readOk ? "info" : "warn", "connector.health", {
    provider: connection.provider,
    connectionId: connection.id,
    authorizationOk,
    readOk,
    severity,
  });

  return {
    connectionId: connection.id,
    provider: connection.provider,
    authorizationOk,
    readOk,
    latencyMs,
    severity,
    errorCode,
    errorMessage,
    daysUntilExpiry,
    statusAfter,
  };
}

export interface HealthSweepResult {
  checked: number;
  healthy: number;
  failing: number;
  expiringSoon: number;
  outcomes: HealthCheckOutcome[];
}

/** Check every non-revoked connection. Driven by `integration_health_v1`. */
export async function sweepConnections(options?: {
  projectId?: string | null;
  fetchImpl?: FetchLike;
}): Promise<HealthSweepResult> {
  const connections = await store.listConnections({
    projectId: options?.projectId ?? null,
  });
  const outcomes: HealthCheckOutcome[] = [];
  for (const connection of connections) {
    try {
      outcomes.push(await checkConnection(connection.id, { fetchImpl: options?.fetchImpl }));
    } catch (err) {
      log("warn", "connector.health.sweep_error", {
        connectionId: connection.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const expiring = await store.expiringConnections(EXPIRY_WARNING_DAYS);
  return {
    checked: outcomes.length,
    healthy: outcomes.filter((o) => o.authorizationOk && o.readOk).length,
    failing: outcomes.filter((o) => !o.authorizationOk || !o.readOk).length,
    expiringSoon: expiring.length,
    outcomes,
  };
}

/**
 * Which capabilities a client's reporting can currently rely on. Reporting
 * calls this so a report can disclose a gap rather than quietly omit a metric —
 * an absent number that looks like a zero is the failure mode that matters.
 */
export async function reportingReadiness(projectId: string): Promise<{
  ready: boolean;
  stale: string[];
  missing: string[];
  freshness: Awaited<ReturnType<typeof store.capabilityFreshness>>;
}> {
  const freshness = await store.capabilityFreshness(projectId);
  const stale: string[] = [];
  const missing: string[] = [];
  const staleAfterMs = 3 * 86_400_000;

  for (const entry of freshness) {
    if (entry.lastOkAt === null) {
      missing.push(entry.capability);
    } else if (Date.now() - entry.lastOkAt.getTime() > staleAfterMs) {
      stale.push(entry.capability);
    }
  }
  return { ready: stale.length === 0 && missing.length === 0, stale, missing, freshness };
}
