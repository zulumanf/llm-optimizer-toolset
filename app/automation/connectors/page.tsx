/**
 * The connector page.
 *
 * The most important thing on it is the status column, and the most important
 * thing about the status column is that it does not lie. No adapter that talks to
 * a real third party is labelled `verified`, because none has been executed
 * against one from this repository.
 */
import { PageHeader, PageShell } from "@/components/layout/page";
import { AlertTriangle } from "lucide-react";
import { listConnectors, connectorStatusCounts } from "@/lib/connectors/registry";
import { CONNECTOR_CAPABILITIES, EXPIRY_WARNING_DAYS } from "@/lib/connectors/types";
import { unsupportedCapabilities } from "@/lib/connectors/registry";
import { healthSummaries, connectorMetrics, capabilityFreshness } from "@/db/connectors";
import { encryptionAvailable } from "@/lib/security/envelope";
import { Badge } from "@/components/ui/badge";
import { AutomationNav } from "@/components/automation/nav";
import { EmptyState } from "@/components/automation/empty-state";
import { TestConnectionButton } from "@/components/automation/test-connection-button";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<string, string> = {
  verified: "Verified — exercised end to end here",
  implemented_unverified: "Implemented, never run live",
  contract_only: "Contract and fixture mode only",
};

export default async function ConnectorsPage() {
  const [health, metrics, freshness] = await Promise.all([
    healthSummaries(),
    connectorMetrics(),
    capabilityFreshness(null),
  ]);

  const connectors = listConnectors();
  const counts = connectorStatusCounts();
  const uncovered = unsupportedCapabilities(CONNECTOR_CAPABILITIES);
  const metricsByProvider = new Map(metrics.map((m) => [m.provider, m]));
  const keyReady = encryptionAvailable();

  return (
    <PageShell>
      <PageHeader
        title="Connectors"
        description={
          <>
        Workflows name a capability; the connector layer decides which provider
        serves it. Credentials never leave{" "}
        <code className="font-mono text-xs">lib/connectors/credentials.ts</code> —
        no node, agent, page, or adapter can read one.
          </>
        }
      />

      <AutomationNav current="connectors" />

      {!keyReady ? (
        <div className="mb-6 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium">
              <code className="font-mono text-xs">AUTOMATION_CREDENTIAL_KEY</code> is not set.
            </p>
            <p className="text-muted-foreground">
              Credentials cannot be stored or read. The layer fails closed rather
              than falling back to plaintext.
            </p>
          </div>
        </div>
      ) : null}

      <section className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
        <p className="text-sm font-medium">What &ldquo;verified&rdquo; means here</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {counts.verified} adapters are verified: the fixture, CSV, manual,
          internal-notification and local-file-store adapters, all of which run
          entirely inside this platform. The {counts.implemented_unverified}{" "}
          provider adapters are written against each vendor&rsquo;s documented HTTP
          contract and shape-tested against captured fixtures, but{" "}
          <strong>none has been executed against the live API</strong> — no
          provider credentials exist in this environment. {counts.contract_only}{" "}
          are contract-and-fixture only. Nothing here is production-ready until
          someone runs it with real credentials.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Adapters</h2>
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs">
              <tr>
                <th className="p-2">Provider</th>
                <th className="p-2">Category</th>
                <th className="p-2">Status</th>
                <th className="p-2 text-right">Capabilities</th>
                <th className="p-2 text-right">Calls</th>
                <th className="p-2">What remains</th>
              </tr>
            </thead>
            <tbody>
              {connectors.map((connector) => {
                const metric = metricsByProvider.get(connector.provider);
                return (
                  <tr key={connector.id} className="border-t align-top">
                    <td className="p-2">
                      <span className="font-mono text-xs">{connector.provider}</span>
                      <span className="ml-1 text-xs text-muted-foreground">
                        v{connector.version}
                      </span>
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">{connector.category}</td>
                    <td className="p-2">
                      <Badge
                        variant={
                          connector.status === "verified"
                            ? "outline"
                            : connector.status === "contract_only"
                              ? "outline"
                              : "secondary"
                        }
                        title={STATUS_LABEL[connector.status]}
                      >
                        {connector.status.replace(/_/g, " ")}
                      </Badge>
                    </td>
                    <td className="p-2 text-right tabular-nums text-xs">
                      {connector.capabilities.length}
                    </td>
                    <td className="p-2 text-right tabular-nums text-xs">
                      {metric === undefined || metric.attempts === 0
                        ? "—"
                        : `${metric.successes}/${metric.attempts}`}
                    </td>
                    <td className="p-2 max-w-md text-xs text-muted-foreground">
                      {connector.outstandingWork.length === 0 ? (
                        <span>nothing outstanding</span>
                      ) : (
                        <ul className="list-disc space-y-0.5 pl-4">
                          {connector.outstandingWork.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Connections</h2>
        {health.length === 0 ? (
          <EmptyState
            title="No provider is connected"
            body="Workflows that require a capability will refuse to start in live mode until one is. They still run in test mode, from fixtures."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Provider</th>
                  <th className="p-2">Scope</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Last probe</th>
                  <th className="p-2">Last sync</th>
                  <th className="p-2">Expiry</th>
                  <th className="p-2">Last error</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {health.map((connection) => {
                  const daysToExpiry =
                    connection.expiresAt === null
                      ? null
                      : Math.floor(
                          (connection.expiresAt.getTime() - Date.now()) / 86_400_000
                        );
                  return (
                    <tr key={connection.connectionId} className="border-t align-top">
                      <td className="p-2 font-mono text-xs">{connection.provider}</td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {connection.projectId === null ? "platform" : "client"}
                      </td>
                      <td className="p-2">
                        <Badge
                          variant={
                            connection.status === "active"
                              ? "outline"
                              : connection.status === "revoked"
                                ? "outline"
                                : "destructive"
                          }
                        >
                          {connection.status.replace(/_/g, " ")}
                        </Badge>
                        {connection.consecutiveFailures > 0 ? (
                          <span className="ml-1 text-xs text-destructive">
                            {connection.consecutiveFailures} failure(s)/24h
                          </span>
                        ) : null}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {connection.lastCheckedAt === null
                          ? "never"
                          : `${connection.lastCheckedAt.toISOString().slice(0, 16).replace("T", " ")}${
                              connection.authorizationOk === false ? " (auth failed)" : ""
                            }`}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {connection.lastSyncAt === null
                          ? "never"
                          : connection.lastSyncAt.toISOString().slice(0, 16).replace("T", " ")}
                      </td>
                      <td className="p-2 text-xs">
                        {daysToExpiry === null ? (
                          <span className="text-muted-foreground">none</span>
                        ) : daysToExpiry <= EXPIRY_WARNING_DAYS ? (
                          <span className="text-destructive">{daysToExpiry}d</span>
                        ) : (
                          <span className="text-muted-foreground">{daysToExpiry}d</span>
                        )}
                      </td>
                      <td className="p-2 max-w-xs text-xs text-muted-foreground">
                        {connection.lastError ?? "—"}
                      </td>
                      <td className="p-2">
                        <TestConnectionButton connectionId={connection.connectionId} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Data freshness</h2>
        {freshness.length === 0 ? (
          <EmptyState
            title="No live ingestion has run"
            body="Reporting reads this to decide whether it can state a metric. A capability with no successful sync is disclosed as missing, never reported as zero."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Capability</th>
                  <th className="p-2">Last success</th>
                  <th className="p-2 text-right">Success rate</th>
                  <th className="p-2 text-right">Attempts</th>
                </tr>
              </thead>
              <tbody>
                {freshness.map((entry) => (
                  <tr key={entry.capability} className="border-t">
                    <td className="p-2 font-mono text-xs">{entry.capability}</td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {entry.lastOkAt === null
                        ? "never"
                        : entry.lastOkAt.toISOString().slice(0, 16).replace("T", " ")}
                    </td>
                    <td className="p-2 text-right tabular-nums text-xs">
                      {Math.round(entry.successRate * 100)}%
                    </td>
                    <td className="p-2 text-right tabular-nums text-xs">{entry.attempts}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {uncovered.length > 0 ? (
        <section>
          <h2 className="mb-2 text-lg font-medium">Capabilities with no adapter</h2>
          <p className="mb-2 text-sm text-muted-foreground">
            A workflow declaring one of these fails validation rather than failing
            at runtime.
          </p>
          <ul className="flex flex-wrap gap-2">
            {uncovered.map((capability) => (
              <li key={capability}>
                <Badge variant="destructive" className="font-mono text-[11px] font-normal">
                  {capability}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">
          Every declared capability has at least one adapter.
        </p>
      )}
    </PageShell>
  );
}
