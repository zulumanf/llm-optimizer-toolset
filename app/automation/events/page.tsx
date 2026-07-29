/**
 * The domain event log and its delivery health.
 *
 * Events are insert-only: this is the record of what the platform believed
 * happened, and editing one would be editing history.
 */
import { listEvents, listDeadLetters, eventStats, listSubscriptions } from "@/db/events";
import { eventTypesByGroup, knownEventTypes } from "@/lib/events/catalog";
import { Badge } from "@/components/ui/badge";
import { AutomationNav } from "@/components/automation/nav";
import { EmptyState } from "@/components/automation/empty-state";
import { ReplayDeadLetterButton } from "@/components/automation/replay-dead-letter";

export const dynamic = "force-dynamic";

export default async function EventsPage() {
  const [events, deadLetters, stats, subscriptions] = await Promise.all([
    listEvents({ limit: 60 }),
    listDeadLetters(40),
    eventStats(40),
    listSubscriptions(),
  ]);

  const groups = [...eventTypesByGroup().entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const subscribedTypes = new Set(subscriptions.filter((s) => s.enabled).map((s) => s.eventType));

  return (
    <div className="mx-auto max-w-7xl p-6">
      <h1 className="text-2xl font-semibold">Domain events</h1>
      <p className="mt-1 mb-4 text-sm text-muted-foreground">
        {knownEventTypes().length} declared types. Publishing is transactional with
        the change that caused it — an event cannot exist for a write that rolled
        back, and a write cannot commit without its event.
      </p>

      <AutomationNav current="events" />

      {deadLetters.length > 0 ? (
        <section className="mb-8">
          <h2 className="mb-2 text-lg font-medium text-destructive">
            Dead-lettered deliveries
          </h2>
          <p className="mb-2 text-sm text-muted-foreground">
            Three attempts failed. Replay is deliberate and safe: idempotent
            consumption means a replayed event cannot start a second run.
          </p>
          <div className="overflow-x-auto rounded-lg border border-destructive/40">
            <table className="w-full text-sm">
              <thead className="bg-destructive/5 text-left text-xs">
                <tr>
                  <th className="p-2">Event type</th>
                  <th className="p-2">Would start</th>
                  <th className="p-2 text-right">Attempts</th>
                  <th className="p-2">Last error</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {deadLetters.map((letter) => (
                  <tr key={letter.id} className="border-t align-top">
                    <td className="p-2 font-mono text-xs">{letter.eventType}</td>
                    <td className="p-2 font-mono text-xs">{letter.workflowKey}</td>
                    <td className="p-2 text-right tabular-nums text-xs">{letter.attempts}</td>
                    <td className="p-2 max-w-sm text-xs text-muted-foreground">
                      {letter.lastError ?? "—"}
                    </td>
                    <td className="p-2">
                      <ReplayDeadLetterButton attemptId={letter.id} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Delivery by type</h2>
        {stats.length === 0 ? (
          <EmptyState
            title="No events published yet"
            body="Services publish events as part of the transaction that changes state. Nothing has done so in this database yet."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Type</th>
                  <th className="p-2 text-right">Published</th>
                  <th className="p-2 text-right">Delivered</th>
                  <th className="p-2 text-right">Dead-lettered</th>
                  <th className="p-2">Subscribed</th>
                  <th className="p-2">Last</th>
                </tr>
              </thead>
              <tbody>
                {stats.map((entry) => (
                  <tr key={entry.type} className="border-t">
                    <td className="p-2 font-mono text-xs">{entry.type}</td>
                    <td className="p-2 text-right tabular-nums">{entry.published}</td>
                    <td className="p-2 text-right tabular-nums">{entry.delivered}</td>
                    <td
                      className={`p-2 text-right tabular-nums ${
                        entry.deadLettered > 0 ? "text-destructive" : ""
                      }`}
                    >
                      {entry.deadLettered}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {subscribedTypes.has(entry.type) ? "yes" : "no consumer"}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {entry.lastAt?.toISOString().slice(0, 16).replace("T", " ") ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Recent events</h2>
        {events.length === 0 ? (
          <EmptyState
            title="The log is empty"
            body="Every event carries a correlation id and, where one exists, the id of the event that caused it — so a chain of work can be traced end to end."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Occurred</th>
                  <th className="p-2">Type</th>
                  <th className="p-2 text-right">v</th>
                  <th className="p-2">Source</th>
                  <th className="p-2">Client</th>
                  <th className="p-2">Correlation</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id} className="border-t">
                    <td className="p-2 text-xs text-muted-foreground">
                      {event.occurredAt.slice(0, 19).replace("T", " ")}
                    </td>
                    <td className="p-2 font-mono text-xs">{event.type}</td>
                    <td className="p-2 text-right tabular-nums text-xs">{event.version}</td>
                    <td className="p-2 text-xs text-muted-foreground">{event.source}</td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {event.projectId === null ? "platform" : event.projectId.slice(0, 8)}
                    </td>
                    <td className="p-2 font-mono text-[11px] text-muted-foreground">
                      {event.correlationId.slice(0, 8)}
                      {event.causationId !== null ? ` ← ${event.causationId.slice(0, 8)}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-medium">Catalogue</h2>
        <p className="mb-3 text-sm text-muted-foreground">
          Every type is declared with a payload schema and a version. Publishing an
          undeclared type, or a payload that fails its schema, is refused.
        </p>
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {groups.map(([group, entries]) => (
            <div key={group} className="rounded-lg border p-3">
              <h3 className="mb-1 text-sm font-medium">{group}</h3>
              <ul className="space-y-1">
                {entries.map((entry) => (
                  <li key={entry.type} className="text-xs">
                    <span className="font-mono">{entry.type.split(".")[1]}</span>
                    {subscribedTypes.has(entry.type) ? (
                      <Badge variant="outline" className="ml-1 text-[10px] font-normal">
                        consumed
                      </Badge>
                    ) : null}
                    <p className="text-muted-foreground">{entry.description}</p>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
