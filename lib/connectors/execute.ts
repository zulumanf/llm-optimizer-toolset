/**
 * The single door to every external system.
 *
 * Everything consequential this platform does to the outside world passes
 * through `executeCapability`, which is why the checks live here rather than in
 * each node:
 *
 *   1. resolve the connection for THIS run's tenant, and fail loudly on a
 *      mismatch rather than quietly returning nothing;
 *   2. refuse a revoked or expired authorisation;
 *   3. refuse a consequential capability in test mode, recording what would
 *      have happened;
 *   4. decrypt the secret into a closure that lives for one call;
 *   5. call the adapter with timeout, retry and rate-limit accounting;
 *   6. record a sync run and an audit row, both redacted;
 *   7. classify every failure into an exception with an owner and an SLA.
 *
 * A node handler cannot skip any of it, because a node handler has no other way
 * to reach a provider.
 */
import type { JSONValue } from "postgres";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import * as store from "@/db/connectors";
import { connectorFetch, type FetchLike } from "@/lib/connectors/http";
import { getConnector, providersFor } from "@/lib/connectors/registry";
import { resolveSecrets, isExpired } from "@/lib/connectors/credentials";
import {
  executionFailure,
  isConsequential,
  isMutating,
  type ConnectorCapability,
  type ConnectorExecutionContext,
  type ConnectorExecutionResult,
} from "@/lib/connectors/types";
import { redactSecrets, redactString } from "@/lib/security/envelope";
import { ClassifiedError } from "@/lib/errors";
import { log } from "@/lib/logger";
import { raiseException } from "@/lib/workflow/exceptions";

export interface ExecuteCapabilityInput {
  capability: ConnectorCapability;
  /** The tenant the CALLING RUN belongs to. Not negotiable, not defaulted. */
  projectId: string | null;
  input: Record<string, unknown>;
  /** 'test' forces fixture reads and refuses consequential writes. */
  mode: "live" | "test";
  /** Provider override; otherwise the client's connected provider is used. */
  provider?: string;
  workflowRunId?: string | null;
  nodeRunId?: string | null;
  /** Fixture bundle for test runs and demos. */
  fixtures?: Record<string, unknown>;
  /** Test runs may opt into real CRM writes; consequential sends never. */
  allowCrmWrites?: boolean;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  /** Injected in tests so no test ever reaches the network. */
  fetchImpl?: FetchLike;
}

export interface CapabilityOutcome<T = unknown> extends ConnectorExecutionResult<T> {
  provider: string;
  connectionId: string | null;
  /** Set when test mode refused a consequential action. */
  wouldHaveSent?: Record<string, unknown>;
}

/**
 * Record a refused test-mode action. The ledger IS the product of a test run:
 * "what would this have done" is the question a test run exists to answer.
 */
async function recordTestAction(args: {
  workflowRunId: string | null;
  nodeRunId: string | null;
  capability: string;
  wouldHaveSent: Record<string, unknown>;
  reason: string;
}): Promise<void> {
  if (!args.workflowRunId) return;
  await sql`
    insert into workflow_test_actions (
      workflow_run_id, node_run_id, capability, would_have_sent, reason
    ) values (
      ${args.workflowRunId}, ${args.nodeRunId}, ${args.capability},
      ${sql.json(redactSecrets(args.wouldHaveSent) as never)}, ${args.reason}
    )
  `;
}

export async function executeCapability<T = unknown>(
  args: ExecuteCapabilityInput
): Promise<CapabilityOutcome<T>> {
  // ---- 1. Which provider? -------------------------------------------------
  const candidates = args.provider ? [args.provider] : providersFor(args.capability);
  if (candidates.length === 0) {
    throw new ClassifiedError(
      "not_found",
      `No connector implements "${args.capability}". Add an adapter before a workflow depends on it.`
    );
  }

  let connection: Awaited<ReturnType<typeof store.connectionFor>> = null;
  let provider = candidates[0]!;
  for (const candidate of candidates) {
    const found = await store.connectionFor({ projectId: args.projectId, provider: candidate });
    if (found) {
      connection = found;
      provider = candidate;
      break;
    }
  }

  // ---- 2. Test mode with no connection still works, from fixtures ---------
  if (!connection && args.mode === "test") {
    return runFixture<T>(args, "fixture", null);
  }

  if (!connection) {
    const failure = executionFailure<T>({
      error: `No active ${candidates.join(" / ")} connection for this client. Connect the provider first.`,
      errorCode: "no_connection",
      retryable: false,
    });
    await sql.begin((tx) =>
      raiseException(tx, {
        projectId: args.projectId,
        workflowRunId: args.workflowRunId ?? null,
        nodeRunId: args.nodeRunId ?? null,
        kind: "failed_integration",
        severity: "high",
        summary: `${args.capability} needs a connected provider (${candidates.join(", ")}) and none is connected for this client.`,
        recommendedAction: "Connect the provider on the client's integrations page, then retry the node.",
      })
    );
    return { ...failure, provider, connectionId: null };
  }

  // ---- 3. Tenant scope ----------------------------------------------------
  // A client-scoped connection whose project differs from the run's is a
  // defect, not a miss. It fails loudly and raises a critical exception.
  if (connection.projectId !== null && connection.projectId !== args.projectId) {
    await sql.begin((tx) =>
      raiseException(tx, {
        projectId: args.projectId,
        workflowRunId: args.workflowRunId ?? null,
        nodeRunId: args.nodeRunId ?? null,
        kind: "evidence_conflict",
        severity: "critical",
        summary: `Tenant scope violation: run for ${args.projectId ?? "platform"} resolved a connection owned by ${connection.projectId}.`,
        recommendedAction:
          "Treat as a defect. Do not retry until the connection resolution query is fixed.",
      })
    );
    throw new ClassifiedError(
      "forbidden",
      "Connector resolution crossed a tenant boundary; the call was refused."
    );
  }

  if (connection.status === "revoked" || connection.revokedAt !== null) {
    const failure = executionFailure<T>({
      error: `The ${provider} connection has been revoked.`,
      errorCode: "revoked",
      retryable: false,
    });
    return { ...failure, provider, connectionId: connection.id };
  }

  // ---- 4. Test mode: fixtures for reads, refusal for consequential acts ---
  if (args.mode === "test") {
    if (isConsequential(args.capability)) {
      await recordTestAction({
        workflowRunId: args.workflowRunId ?? null,
        nodeRunId: args.nodeRunId ?? null,
        capability: args.capability,
        wouldHaveSent: args.input,
        reason: "consequential capability refused in test mode",
      });
      const failure = executionFailure<T>({
        error: `Test mode refuses "${args.capability}" — it has an irreversible external effect. The intended payload was recorded instead.`,
        errorCode: "test_mode_refused",
        retryable: false,
      });
      return {
        ...failure,
        provider,
        connectionId: connection.id,
        wouldHaveSent: redactSecrets(args.input),
      };
    }
    if (isMutating(args.capability) && args.allowCrmWrites !== true) {
      await recordTestAction({
        workflowRunId: args.workflowRunId ?? null,
        nodeRunId: args.nodeRunId ?? null,
        capability: args.capability,
        wouldHaveSent: args.input,
        reason: "external mutation refused in test mode (allowCrmWrites not set)",
      });
      const failure = executionFailure<T>({
        error: `Test mode refuses "${args.capability}" unless the run explicitly sets allowCrmWrites.`,
        errorCode: "test_mode_refused",
        retryable: false,
      });
      return {
        ...failure,
        provider,
        connectionId: connection.id,
        wouldHaveSent: redactSecrets(args.input),
      };
    }
    return runFixture<T>(args, provider, connection.id);
  }

  // ---- 5. Live execution -------------------------------------------------
  const connector = getConnector(provider);
  let secrets: Awaited<ReturnType<typeof resolveSecrets>>;
  try {
    secrets = await resolveSecrets(connection.id);
  } catch (err) {
    const message = err instanceof ClassifiedError ? err.message : "credential unavailable";
    await sql.begin(async (tx) => {
      await store.setConnectionStatus(tx, {
        connectionId: connection!.id,
        status: "authorization_expired",
        lastError: message,
      });
      await raiseException(tx, {
        projectId: args.projectId,
        workflowRunId: args.workflowRunId ?? null,
        nodeRunId: args.nodeRunId ?? null,
        kind: "failed_integration",
        severity: "high",
        summary: `${provider} credential is unavailable: ${message}`,
        recommendedAction: "Reconnect the provider, then retry the node.",
      });
    });
    const failure = executionFailure<T>({
      error: message,
      errorCode: "authorization_failed",
      retryable: false,
    });
    return { ...failure, provider, connectionId: connection.id };
  }

  let accessToken = secrets.accessToken;

  const syncRunId = await sql.begin((tx) =>
    store.startSyncRun(tx, {
      connectionId: connection!.id,
      projectId: args.projectId,
      capability: args.capability,
      workflowRunId: args.workflowRunId ?? null,
      nodeRunId: args.nodeRunId ?? null,
      mode: "live",
      periodStart: args.periodStart ?? null,
      periodEnd: args.periodEnd ?? null,
    })
  );

  const buildContext = (token: string): ConnectorExecutionContext => ({
    connectionId: connection!.id,
    projectId: args.projectId,
    provider,
    mode: "live",
    config: connection!.config,
    grantedScopes: connection!.grantedScopes,
    // A closure over one call's value. Nothing stores it, nothing returns it.
    secret: () => token,
    refreshSecret: () => secrets.refreshToken,
    http: (request) =>
      connectorFetch(request, {
        provider,
        capability: args.capability,
        fetchImpl: args.fetchImpl,
      }),
    fixtures: args.fixtures ?? {},
    capability: args.capability,
    workflowRunId: args.workflowRunId ?? null,
    nodeRunId: args.nodeRunId ?? null,
  });

  // A token we already know is expired: refresh before spending a request on it.
  if (isExpired(secrets) && connector.refreshAuthorization) {
    const refreshed = await tryRefresh(connector, buildContext(accessToken), connection.id);
    if (refreshed) accessToken = refreshed;
  }

  let result = await connector.execute<Record<string, unknown>, T>(
    args.capability,
    args.input,
    buildContext(accessToken)
  );

  // One refresh-and-retry on an authorisation failure. Exactly one: a loop here
  // would hammer a provider that has genuinely revoked us.
  if (!result.ok && result.errorCode === "authorization_failed" && connector.refreshAuthorization) {
    const refreshed = await tryRefresh(connector, buildContext(accessToken), connection.id);
    if (refreshed) {
      accessToken = refreshed;
      result = await connector.execute<Record<string, unknown>, T>(
        args.capability,
        args.input,
        buildContext(accessToken)
      );
    }
  }

  await sql.begin(async (tx) => {
    await store.finishSyncRun(tx, {
      syncRunId,
      ok: result.ok,
      rowsRead: result.rowsRead,
      rowsWritten: result.rowsWritten,
      latencyMs: result.latencyMs,
      rateLimited: result.rateLimited,
      error: result.error === null ? null : redactString(result.error).slice(0, 500),
    });

    if (result.ok) {
      await store.touchLastSync(tx, connection!.id);
      if (connection!.status !== "active") {
        await store.setConnectionStatus(tx, {
          connectionId: connection!.id,
          status: "active",
          lastError: null,
        });
      }
      // A write to an external system is an action we took: audited, with the
      // redacted payload, so "what did we send them" is answerable later.
      if (isMutating(args.capability)) {
        await writeAudit(tx, {
          userId: null,
          action: `connector.${args.capability}`,
          entity: "connector_connection",
          entityId: connection!.id,
          // Round-tripped through JSON so the stored detail is exactly what a
          // reader will get back, with the redaction already applied.
          detail: JSON.parse(
            JSON.stringify({
              provider,
              workflowRunId: args.workflowRunId ?? null,
              input: redactSecrets(args.input),
              rowsWritten: result.rowsWritten,
            })
          ) as JSONValue,
        });
      }
      return;
    }

    const authFailure = result.errorCode === "authorization_failed";
    await store.setConnectionStatus(tx, {
      connectionId: connection!.id,
      status: authFailure ? "authorization_expired" : "degraded",
      lastError: redactString(result.error ?? "unknown error").slice(0, 500),
    });
    await raiseException(tx, {
      projectId: args.projectId,
      workflowRunId: args.workflowRunId ?? null,
      nodeRunId: args.nodeRunId ?? null,
      kind: "failed_integration",
      severity: authFailure ? "high" : result.rateLimited ? "medium" : "high",
      summary: `${provider} ${args.capability} failed: ${redactString(result.error ?? "unknown error").slice(0, 200)}`,
      detail: {
        errorCode: result.errorCode,
        statusCode: result.statusCode,
        rateLimited: result.rateLimited,
        retryable: result.retryable,
      },
      recommendedAction: authFailure
        ? "Reconnect the provider — the authorisation is no longer valid."
        : result.rateLimited
          ? "Wait for the provider's rate-limit window, then retry the node."
          : "Inspect the provider error, fix the cause, then retry the node.",
    });
  });

  log(result.ok ? "info" : "warn", "connector.execute", {
    provider,
    capability: args.capability,
    ok: result.ok,
    latencyMs: result.latencyMs,
    errorCode: result.errorCode,
  });

  return { ...result, provider, connectionId: connection.id };
}

async function tryRefresh(
  connector: ReturnType<typeof getConnector>,
  ctx: ConnectorExecutionContext,
  connectionId: string
): Promise<string | null> {
  if (!connector.refreshAuthorization) return null;
  try {
    const refresh = await connector.refreshAuthorization(ctx);
    if (!refresh.refreshed || !refresh.accessToken) return null;
    // Re-encryption goes through the credential boundary, not through here.
    const { storeCredential } = await import("@/lib/connectors/credentials");
    const { SYSTEM_USER_ID } = await import("@/lib/auth");
    await storeCredential({
      connectionId,
      kind: "oauth2",
      secret: refresh.accessToken,
      refreshToken: refresh.refreshToken ?? ctx.refreshSecret(),
      expiresAt: refresh.expiresAt ?? null,
      // System-initiated refresh; the audit row records it as such. Must be
      // the REAL system user (migration 037) — a made-up uuid violates the
      // audit_log FK, the refreshed token never persists, and every oauth2
      // connector dies one hour after connecting (found live, spec 092).
      userId: SYSTEM_USER_ID,
    });
    log("info", "connector.token_refreshed", { provider: connector.provider });
    return refresh.accessToken;
  } catch (err) {
    log("warn", "connector.refresh_failed", {
      provider: connector.provider,
      message: redactString(err instanceof Error ? err.message : String(err)),
    });
    return null;
  }
}

/** Serve a capability from the run's fixture bundle. */
async function runFixture<T>(
  args: ExecuteCapabilityInput,
  provider: string,
  connectionId: string | null
): Promise<CapabilityOutcome<T>> {
  const canned = args.fixtures?.[args.capability];
  if (canned === undefined) {
    const failure = executionFailure<T>({
      error: `Test run has no fixture for "${args.capability}". Add one to the workflow fixture so the run is reproducible.`,
      errorCode: "fixture_missing",
      retryable: false,
    });
    return { ...failure, provider, connectionId };
  }
  if (connectionId) {
    await sql.begin(async (tx) => {
      const syncRunId = await store.startSyncRun(tx, {
        connectionId,
        projectId: args.projectId,
        capability: args.capability,
        workflowRunId: args.workflowRunId ?? null,
        nodeRunId: args.nodeRunId ?? null,
        mode: "test",
        periodStart: args.periodStart ?? null,
        periodEnd: args.periodEnd ?? null,
      });
      await store.finishSyncRun(tx, {
        syncRunId,
        ok: true,
        rowsRead: Array.isArray(canned) ? canned.length : 1,
        rowsWritten: 0,
        latencyMs: 0,
        rateLimited: false,
        error: null,
      });
    });
  }
  return {
    ok: true,
    data: redactSecrets(canned) as T,
    error: null,
    errorCode: null,
    statusCode: 200,
    retryable: false,
    rateLimited: false,
    retryAfterSeconds: null,
    latencyMs: 0,
    rowsRead: Array.isArray(canned) ? canned.length : 1,
    rowsWritten: 0,
    redacted: true,
    requestId: null,
    provider,
    connectionId,
  };
}
