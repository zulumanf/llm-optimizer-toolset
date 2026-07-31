/**
 * Triggers: the five ways work starts, and their fire history.
 *
 * A client-scoped workflow's schedule ships disabled on purpose — firing one
 * without a client would run a per-client process with no client.
 */
import { listTriggers, triggerStats, recentReceipts, listWebhookEndpoints } from "@/db/triggers";
import { listSubscriptions } from "@/db/events";
import { listActiveProjects } from "@/db/projects";
import { TriggerClone } from "@/components/automation/trigger-clone";
import { knownMetricKeys } from "@/lib/triggers/threshold";
import { Badge } from "@/components/ui/badge";
import { AutomationNav } from "@/components/automation/nav";
import { EmptyState } from "@/components/automation/empty-state";
import { TriggerToggle } from "@/components/automation/trigger-toggle";

export const dynamic = "force-dynamic";

export default async function TriggersPage() {
  const [triggers, stats, subscriptions, endpoints, receipts, projectRows] =
    await Promise.all([
      listTriggers(),
      triggerStats(),
      listSubscriptions(),
      listWebhookEndpoints(),
      recentReceipts(20),
      listActiveProjects(),
    ]);
  const activeProjects = projectRows.map((p) => ({ id: p.id, name: p.name }));

  return (
    <div className="mx-auto max-w-7xl p-6">
      <h1 className="text-2xl font-semibold">Triggers</h1>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">
        A schedule&rsquo;s fire key is the <em>window&rsquo;s</em> identity, not the moment
        it ran — so any number of dispatchers racing on the same 09:00 slot produce
        exactly one run.
      </p>

      <AutomationNav current="triggers" />

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Schedules and thresholds</h2>
        {triggers.length === 0 ? (
          <EmptyState
            title="No triggers installed"
            body="Bootstrap installs one per declared trigger when the worker starts. Client-scoped schedules install disabled and are enabled per client."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Trigger</th>
                  <th className="p-2">Kind</th>
                  <th className="p-2">Workflow</th>
                  <th className="p-2">Schedule / condition</th>
                  <th className="p-2">Missed runs</th>
                  <th className="p-2">Next</th>
                  <th className="p-2 text-right">Fires</th>
                  <th className="p-2">Enabled</th>
                </tr>
              </thead>
              <tbody>
                {triggers.map((trigger) => {
                  const stat = stats.get(trigger.id);
                  return (
                    <tr key={trigger.id} className="border-t align-top">
                      <td className="p-2 font-mono text-xs">{trigger.key}</td>
                      <td className="p-2">
                        <Badge variant="outline">{trigger.kind}</Badge>
                      </td>
                      <td className="p-2 font-mono text-xs">{trigger.workflowKey}</td>
                      <td className="p-2 text-xs">
                        {trigger.kind === "schedule" ? (
                          <span className="font-mono">
                            {trigger.cron} ({trigger.timezone})
                          </span>
                        ) : trigger.kind === "threshold" ? (
                          <span className="font-mono">
                            {trigger.metricKey} {trigger.comparison} {trigger.thresholdValue}
                            <span className="text-muted-foreground">
                              {" "}
                              (min sample {trigger.minimumSample ?? 1})
                            </span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {trigger.missedRunPolicy.replace(/_/g, " ")}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {trigger.nextRunAt === null
                          ? "—"
                          : trigger.nextRunAt.toISOString().slice(0, 16).replace("T", " ")}
                      </td>
                      <td className="p-2 text-right tabular-nums text-xs">
                        {stat === undefined ? "—" : `${stat.fired}/${stat.fires}`}
                        {stat !== undefined && stat.failed > 0 ? (
                          <span className="text-destructive"> ({stat.failed} failed)</span>
                        ) : null}
                      </td>
                      <td className="p-2">
                        <div className="flex flex-col gap-1.5">
                          <TriggerToggle triggerId={trigger.id} enabled={trigger.enabled} />
                          {trigger.kind === "schedule" &&
                            trigger.projectId === null &&
                            activeProjects.length > 0 && (
                              <TriggerClone
                                triggerId={trigger.id}
                                projects={activeProjects}
                              />
                            )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Threshold metrics available: {knownMetricKeys().join(", ")}. Each is a
          named deterministic calculation — there is no generic &ldquo;run this
          SQL&rdquo; escape hatch.
        </p>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Event subscriptions</h2>
        {subscriptions.length === 0 ? (
          <EmptyState
            title="No subscriptions"
            body="A subscription is what turns a domain event into a workflow run, and it must state why starting unattended is safe."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Event type</th>
                  <th className="p-2">Starts</th>
                  <th className="p-2">Filter</th>
                  <th className="p-2">Why unattended is safe</th>
                  <th className="p-2">Enabled</th>
                </tr>
              </thead>
              <tbody>
                {subscriptions.map((subscription) => (
                  <tr key={subscription.id} className="border-t align-top">
                    <td className="p-2 font-mono text-xs">{subscription.eventType}</td>
                    <td className="p-2 font-mono text-xs">{subscription.workflowKey}</td>
                    <td className="p-2 font-mono text-[11px] text-muted-foreground">
                      {subscription.filter.kind === "always"
                        ? "always"
                        : JSON.stringify(subscription.filter)}
                    </td>
                    <td className="p-2 max-w-md text-xs text-muted-foreground">
                      {subscription.autonomyNote || "—"}
                    </td>
                    <td className="p-2 text-xs">{subscription.enabled ? "yes" : "no"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Webhook endpoints</h2>
        {endpoints.length === 0 ? (
          <EmptyState
            title="No webhook endpoints"
            body="An endpoint is created disabled and stays disabled until a signing secret is stored — accepting unsigned traffic is not a default we offer."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Slug</th>
                  <th className="p-2">Provider</th>
                  <th className="p-2">Publishes</th>
                  <th className="p-2">Signature</th>
                  <th className="p-2 text-right">Rate limit</th>
                  <th className="p-2">Enabled</th>
                </tr>
              </thead>
              <tbody>
                {endpoints.map((endpoint) => (
                  <tr key={endpoint.id} className="border-t">
                    <td className="p-2 font-mono text-xs">/api/webhooks/{endpoint.slug}</td>
                    <td className="p-2 text-xs">{endpoint.provider}</td>
                    <td className="p-2 font-mono text-xs">{endpoint.eventType}</td>
                    <td className="p-2 text-xs">
                      {endpoint.signatureScheme === "none" ? (
                        <Badge variant="destructive">unsigned</Badge>
                      ) : (
                        endpoint.signatureScheme
                      )}
                    </td>
                    <td className="p-2 text-right tabular-nums text-xs">
                      {endpoint.rateLimitPerMinute}/min
                    </td>
                    <td className="p-2 text-xs">
                      {endpoint.revokedAt !== null
                        ? "revoked"
                        : endpoint.enabled
                          ? "yes"
                          : "no"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-medium">Recent webhook receipts</h2>
        {receipts.length === 0 ? (
          <EmptyState
            title="Nothing received"
            body="Every request is recorded with its signature verdict, including the ones that were rejected — a refused webhook that leaves no trace is indistinguishable from one that never arrived."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Received</th>
                  <th className="p-2">Endpoint</th>
                  <th className="p-2">Provider event</th>
                  <th className="p-2">Signature</th>
                  <th className="p-2">Outcome</th>
                  <th className="p-2">Error</th>
                </tr>
              </thead>
              <tbody>
                {receipts.map((receipt) => (
                  <tr key={receipt.id} className="border-t">
                    <td className="p-2 text-xs text-muted-foreground">
                      {receipt.receivedAt.toISOString().slice(0, 19).replace("T", " ")}
                    </td>
                    <td className="p-2 font-mono text-xs">{receipt.slug}</td>
                    <td className="p-2 font-mono text-[11px] text-muted-foreground">
                      {receipt.providerEventId.slice(0, 24)}
                    </td>
                    <td className="p-2 text-xs">
                      {receipt.signatureValid ? "valid" : (
                        <span className="text-destructive">invalid</span>
                      )}
                    </td>
                    <td className="p-2">
                      <Badge
                        variant={receipt.status === "accepted" ? "outline" : "secondary"}
                      >
                        {receipt.status.replace(/_/g, " ")}
                      </Badge>
                    </td>
                    <td className="p-2 max-w-xs text-xs text-muted-foreground">
                      {receipt.error ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
