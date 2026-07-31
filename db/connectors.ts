/**
 * All SQL for connector connections, credentials, health and sync runs.
 *
 * SECURITY BOUNDARY. This module exports **no** function that returns a
 * credential's plaintext, and exactly one (`credentialMaterial`) that returns
 * ciphertext. That function is imported by `lib/connectors/credentials.ts` and
 * by nothing else — a rule an import-boundary test enforces rather than trusts.
 *
 * Every read takes an explicit projectId where a cross-client leak would be
 * possible. `connectionFor` is the accessor the execution path uses, and it
 * requires the caller to state the tenant it believes it is acting for.
 */
import { sql, type TransactionSql } from "@/db/client";
import type {
  ConnectionStatus,
  ConnectorConnection,
  CredentialKind,
} from "@/lib/connectors/types";

type Tx = TransactionSql | typeof sql;

/** Columns that are safe to select anywhere. Credential columns are absent. */
const CONNECTION_COLUMNS = sql`
  id, project_id, provider, connection_name, external_account_id, status,
  granted_scopes, config, last_test_at, last_test_ok, last_sync_at, last_error,
  expires_at, created_by, revoked_at
`;

function toConnection(row: Record<string, unknown>): ConnectorConnection {
  return {
    id: row.id as string,
    projectId: (row.projectId as string | null) ?? null,
    provider: row.provider as string,
    connectionName: (row.connectionName as string) ?? "",
    externalAccountId: (row.externalAccountId as string) ?? "",
    status: row.status as ConnectionStatus,
    grantedScopes: (row.grantedScopes as string[]) ?? [],
    config: (row.config as Record<string, unknown>) ?? {},
    lastTestAt: (row.lastTestAt as Date | null) ?? null,
    lastTestOk: (row.lastTestOk as boolean | null) ?? null,
    lastSyncAt: (row.lastSyncAt as Date | null) ?? null,
    lastError: (row.lastError as string | null) ?? null,
    expiresAt: (row.expiresAt as Date | null) ?? null,
    createdBy: (row.createdBy as string | null) ?? null,
    revokedAt: (row.revokedAt as Date | null) ?? null,
  };
}

export async function insertConnection(
  tx: Tx,
  args: {
    projectId: string | null;
    provider: string;
    connectionName: string;
    externalAccountId: string;
    grantedScopes: string[];
    config: Record<string, unknown>;
    expiresAt: Date | null;
    createdBy: string | null;
  }
): Promise<string> {
  const [row] = await tx`
    insert into connector_connections (
      project_id, provider, connection_name, external_account_id,
      granted_scopes, config, expires_at, created_by, status
    ) values (
      ${args.projectId}, ${args.provider}, ${args.connectionName},
      ${args.externalAccountId}, ${args.grantedScopes},
      ${tx.json(args.config as never)}, ${args.expiresAt}, ${args.createdBy}, 'pending'
    )
    returning id
  `;
  return row!.id as string;
}

export async function getConnection(connectionId: string): Promise<ConnectorConnection | null> {
  const rows = await sql`
    select ${CONNECTION_COLUMNS} from connector_connections where id = ${connectionId}
  `;
  return rows[0] ? toConnection(rows[0]) : null;
}

/**
 * The connection the execution path uses. The caller must pass the project it
 * believes it is acting for; a connection belonging to a different client is
 * simply not returned, and `lib/connectors/execute.ts` turns that into a
 * tenant-scope exception rather than a quiet miss.
 */
export async function connectionFor(args: {
  projectId: string | null;
  provider: string;
}): Promise<ConnectorConnection | null> {
  const rows = await sql`
    select ${CONNECTION_COLUMNS} from connector_connections
    where provider = ${args.provider}
      and revoked_at is null
      -- Either this client's own connection, or a platform-level one
      -- (project_id is null: internal Slack, the local file store). A
      -- platform connection carries no client data of its own — the payload
      -- always comes from the calling run's scope.
      and (project_id = ${args.projectId} or project_id is null)
    -- Prefer the client's own connection over the platform fallback.
    order by (project_id is not null) desc, created_at desc
    limit 1
  `;
  return rows[0] ? toConnection(rows[0]) : null;
}

export async function listConnections(filters?: {
  projectId?: string | null;
  provider?: string;
  includeRevoked?: boolean;
}): Promise<ConnectorConnection[]> {
  const rows = await sql`
    select ${CONNECTION_COLUMNS} from connector_connections
    where (${filters?.projectId ?? null}::uuid is null
           or project_id = ${filters?.projectId ?? null})
      and (${filters?.provider ?? null}::text is null
           or provider = ${filters?.provider ?? null})
      and (${filters?.includeRevoked ?? false} or revoked_at is null)
    order by provider, created_at desc
  `;
  return rows.map(toConnection);
}

export async function setConnectionStatus(
  tx: Tx,
  args: {
    connectionId: string;
    status: ConnectionStatus;
    lastError?: string | null;
    expiresAt?: Date | null;
    grantedScopes?: string[] | null;
  }
): Promise<void> {
  await tx`
    update connector_connections set
      status = ${args.status},
      last_error = ${args.lastError === undefined ? sql`last_error` : args.lastError},
      expires_at = ${args.expiresAt === undefined ? sql`expires_at` : args.expiresAt},
      granted_scopes = ${
        args.grantedScopes === undefined || args.grantedScopes === null
          ? sql`granted_scopes`
          : args.grantedScopes
      }
    where id = ${args.connectionId}
  `;
}

export async function recordTestResult(
  tx: Tx,
  args: { connectionId: string; ok: boolean; error: string | null }
): Promise<void> {
  await tx`
    update connector_connections set
      last_test_at = now(), last_test_ok = ${args.ok}, last_error = ${args.error}
    where id = ${args.connectionId}
  `;
}

export async function touchLastSync(tx: Tx, connectionId: string): Promise<void> {
  await tx`update connector_connections set last_sync_at = now() where id = ${connectionId}`;
}

export async function revokeConnection(
  tx: Tx,
  args: { connectionId: string; userId: string }
): Promise<void> {
  // The credential row goes; the connection row stays, revoked, for audit.
  await tx`delete from connector_credentials where connection_id = ${args.connectionId}`;
  await tx`
    update connector_connections set
      status = 'revoked', revoked_at = now(), revoked_by = ${args.userId}
    where id = ${args.connectionId}
  `;
}

/** Connections inside the expiry warning window, for the health workflow. */
export async function expiringConnections(days: number): Promise<ConnectorConnection[]> {
  const rows = await sql`
    select ${CONNECTION_COLUMNS} from connector_connections
    where revoked_at is null and expires_at is not null
      and expires_at <= now() + make_interval(days => ${days})
    order by expires_at asc
  `;
  return rows.map(toConnection);
}

// -------------------------------------------------------------- credentials

export interface CredentialMaterial {
  kind: CredentialKind;
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  refreshCiphertext: Buffer | null;
  refreshIv: Buffer | null;
  refreshAuthTag: Buffer | null;
  keyVersion: number;
  expiresAt: Date | null;
}

export async function upsertCredential(
  tx: Tx,
  args: {
    connectionId: string;
    kind: CredentialKind;
    ciphertext: Buffer;
    iv: Buffer;
    authTag: Buffer;
    refreshCiphertext: Buffer | null;
    refreshIv: Buffer | null;
    refreshAuthTag: Buffer | null;
    keyVersion: number;
    expiresAt: Date | null;
  }
): Promise<void> {
  await tx`
    insert into connector_credentials (
      connection_id, kind, ciphertext, iv, auth_tag,
      refresh_ciphertext, refresh_iv, refresh_auth_tag, key_version, expires_at
    ) values (
      ${args.connectionId}, ${args.kind}, ${args.ciphertext}, ${args.iv}, ${args.authTag},
      ${args.refreshCiphertext}, ${args.refreshIv}, ${args.refreshAuthTag},
      ${args.keyVersion}, ${args.expiresAt}
    )
    on conflict (connection_id) do update set
      kind = excluded.kind,
      ciphertext = excluded.ciphertext,
      iv = excluded.iv,
      auth_tag = excluded.auth_tag,
      refresh_ciphertext = excluded.refresh_ciphertext,
      refresh_iv = excluded.refresh_iv,
      refresh_auth_tag = excluded.refresh_auth_tag,
      key_version = excluded.key_version,
      expires_at = excluded.expires_at,
      rotated_at = now()
  `;
}

/**
 * Ciphertext for one connection. THE ONLY accessor that touches these columns.
 * Callers outside lib/connectors/credentials.ts are a defect, and
 * tests/unit/connector-security.test.ts asserts the import boundary.
 */
export async function credentialMaterial(
  connectionId: string
): Promise<CredentialMaterial | null> {
  const [row] = await sql`
    select kind, ciphertext, iv, auth_tag, refresh_ciphertext, refresh_iv,
           refresh_auth_tag, key_version, expires_at
    from connector_credentials where connection_id = ${connectionId}
  `;
  if (!row) return null;
  return {
    kind: row.kind as CredentialKind,
    ciphertext: row.ciphertext as Buffer,
    iv: row.iv as Buffer,
    authTag: row.authTag as Buffer,
    refreshCiphertext: (row.refreshCiphertext as Buffer | null) ?? null,
    refreshIv: (row.refreshIv as Buffer | null) ?? null,
    refreshAuthTag: (row.refreshAuthTag as Buffer | null) ?? null,
    keyVersion: Number(row.keyVersion ?? 1),
    expiresAt: (row.expiresAt as Date | null) ?? null,
  };
}

export async function hasCredential(connectionId: string): Promise<boolean> {
  const [row] = await sql`
    select 1 as present from connector_credentials where connection_id = ${connectionId}
  `;
  return Boolean(row);
}

// ------------------------------------------------------------------ health

export async function insertHealthCheck(
  tx: Tx,
  args: {
    connectionId: string;
    projectId: string | null;
    authorizationOk: boolean;
    readOk: boolean;
    latencyMs: number | null;
    errorCode: string | null;
    errorMessage: string | null;
    severity: "low" | "medium" | "high" | "critical";
    detail: Record<string, unknown>;
  }
): Promise<string> {
  const [row] = await tx`
    insert into connector_health_checks (
      connection_id, project_id, authorization_ok, read_ok, latency_ms,
      error_code, error_message, severity, detail
    ) values (
      ${args.connectionId}, ${args.projectId}, ${args.authorizationOk}, ${args.readOk},
      ${args.latencyMs}, ${args.errorCode}, ${args.errorMessage}, ${args.severity},
      ${tx.json(args.detail as never)}
    )
    returning id
  `;
  return row!.id as string;
}

export interface HealthSummary {
  connectionId: string;
  provider: string;
  projectId: string | null;
  status: ConnectionStatus;
  lastCheckedAt: Date | null;
  authorizationOk: boolean | null;
  readOk: boolean | null;
  consecutiveFailures: number;
  lastSyncAt: Date | null;
  lastError: string | null;
  expiresAt: Date | null;
}

export async function healthSummaries(projectId?: string | null): Promise<HealthSummary[]> {
  const rows = await sql`
    with latest as (
      select distinct on (connection_id)
        connection_id, checked_at, authorization_ok, read_ok
      from connector_health_checks
      order by connection_id, checked_at desc
    ),
    failures as (
      select connection_id, count(*)::int as n
      from connector_health_checks
      where checked_at > now() - interval '24 hours'
        and (authorization_ok = false or read_ok = false)
      group by connection_id
    )
    select c.id as connection_id, c.provider, c.project_id, c.status,
           c.last_sync_at, c.last_error, c.expires_at,
           l.checked_at as last_checked_at, l.authorization_ok, l.read_ok,
           coalesce(f.n, 0) as consecutive_failures
    from connector_connections c
    left join latest l on l.connection_id = c.id
    left join failures f on f.connection_id = c.id
    where c.revoked_at is null
      and (${projectId ?? null}::uuid is null or c.project_id = ${projectId ?? null})
    order by c.provider
  `;
  return rows.map((r) => ({
    connectionId: r.connectionId as string,
    provider: r.provider as string,
    projectId: (r.projectId as string | null) ?? null,
    status: r.status as ConnectionStatus,
    lastCheckedAt: (r.lastCheckedAt as Date | null) ?? null,
    authorizationOk: (r.authorizationOk as boolean | null) ?? null,
    readOk: (r.readOk as boolean | null) ?? null,
    consecutiveFailures: Number(r.consecutiveFailures ?? 0),
    lastSyncAt: (r.lastSyncAt as Date | null) ?? null,
    lastError: (r.lastError as string | null) ?? null,
    expiresAt: (r.expiresAt as Date | null) ?? null,
  }));
}

// --------------------------------------------------------------- sync runs

export async function startSyncRun(
  tx: Tx,
  args: {
    connectionId: string;
    projectId: string | null;
    capability: string;
    workflowRunId: string | null;
    nodeRunId: string | null;
    mode: "live" | "test";
    periodStart: Date | null;
    periodEnd: Date | null;
  }
): Promise<string> {
  const [row] = await tx`
    insert into connector_sync_runs (
      connection_id, project_id, capability, workflow_run_id, node_run_id, mode,
      period_start, period_end
    ) values (
      ${args.connectionId}, ${args.projectId}, ${args.capability},
      ${args.workflowRunId}, ${args.nodeRunId}, ${args.mode},
      ${args.periodStart}, ${args.periodEnd}
    )
    returning id
  `;
  return row!.id as string;
}

export async function finishSyncRun(
  tx: Tx,
  args: {
    syncRunId: string;
    ok: boolean;
    rowsRead: number;
    rowsWritten: number;
    latencyMs: number;
    rateLimited: boolean;
    error: string | null;
  }
): Promise<void> {
  await tx`
    update connector_sync_runs set
      finished_at = now(), ok = ${args.ok}, rows_read = ${args.rowsRead},
      rows_written = ${args.rowsWritten}, latency_ms = ${args.latencyMs},
      rate_limited = ${args.rateLimited}, error = ${args.error}
    where id = ${args.syncRunId}
  `;
}

export interface CapabilityFreshness {
  capability: string;
  lastOkAt: Date | null;
  lastAttemptAt: Date | null;
  successRate: number;
  attempts: number;
}

export async function capabilityFreshness(
  projectId: string | null
): Promise<CapabilityFreshness[]> {
  const rows = await sql`
    select capability,
      max(started_at) filter (where ok) as last_ok_at,
      max(started_at) as last_attempt_at,
      count(*)::int as attempts,
      count(*) filter (where ok)::int as successes
    from connector_sync_runs
    where (${projectId ?? null}::uuid is null or project_id = ${projectId ?? null})
      and mode = 'live'
    group by capability
    order by capability
  `;
  return rows.map((r) => {
    const attempts = Number(r.attempts ?? 0);
    return {
      capability: r.capability as string,
      lastOkAt: (r.lastOkAt as Date | null) ?? null,
      lastAttemptAt: (r.lastAttemptAt as Date | null) ?? null,
      attempts,
      successRate: attempts === 0 ? 0 : Number(r.successes ?? 0) / attempts,
    };
  });
}

export interface ConnectorMetrics {
  provider: string;
  attempts: number;
  successes: number;
  rateLimited: number;
  avgLatencyMs: number;
  lastSyncAt: Date | null;
}

export async function connectorMetrics(): Promise<ConnectorMetrics[]> {
  const rows = await sql`
    select c.provider,
      count(s.id)::int as attempts,
      count(s.id) filter (where s.ok)::int as successes,
      count(s.id) filter (where s.rate_limited)::int as rate_limited,
      coalesce(avg(s.latency_ms), 0)::int as avg_latency_ms,
      max(s.started_at) as last_sync_at
    from connector_connections c
    left join connector_sync_runs s on s.connection_id = c.id
    where c.revoked_at is null
    group by c.provider
    order by c.provider
  `;
  return rows.map((r) => ({
    provider: r.provider as string,
    attempts: Number(r.attempts ?? 0),
    successes: Number(r.successes ?? 0),
    rateLimited: Number(r.rateLimited ?? 0),
    avgLatencyMs: Number(r.avgLatencyMs ?? 0),
    lastSyncAt: (r.lastSyncAt as Date | null) ?? null,
  }));
}
