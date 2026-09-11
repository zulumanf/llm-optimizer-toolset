/**
 * Outreach safety: sequences, their stop states, and the suppression list.
 *
 * Every stop condition is a recorded terminal state, never the absence of a next
 * step — so a sequence that stopped because someone replied looks different from
 * one that stopped because a dispatcher died.
 */
import { PageHeader, PageShell } from "@/components/layout/page";
import { sql } from "@/db/client";
import { listSuppressions } from "@/lib/outreach/suppression";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { AutomationNav } from "@/components/automation/nav";
import { EmptyState } from "@/components/automation/empty-state";
import { StopSequenceButton } from "@/components/automation/stop-sequence-button";

export const dynamic = "force-dynamic";

const STOP_LABEL: Record<string, string> = {
  active: "active",
  stopped_replied: "stopped — replied",
  stopped_opted_out: "stopped — opted out",
  stopped_bounced: "stopped — hard bounce",
  stopped_booked: "stopped — meeting booked",
  stopped_manual: "stopped — by hand",
  stopped_suppressed: "stopped — suppressed",
  completed: "completed",
};

export default async function OutreachPage() {
  const [sequences, suppressions, messageStats] = await Promise.all([
    sql`
      select s.id, s.subject_kind, s.subject_ref, s.recipient_email, s.recipient_name,
             s.status, s.stop_reason, s.current_step, s.max_steps, s.next_send_at,
             s.created_at, p.name as project_name,
             (select count(*)::int from outreach_messages m
                where m.sequence_id = s.id and m.status = 'sent') as sent
      from outreach_sequences s
      left join projects p on p.id = s.project_id
      order by s.created_at desc
      limit 60
    `,
    listSuppressions({ includeLifted: true, limit: 100 }),
    sql`
      select
        count(*)::int as total,
        count(*) filter (where status = 'sent')::int as sent,
        count(*) filter (where status = 'draft')::int as drafts,
        count(*) filter (where status = 'cancelled')::int as cancelled,
        count(*) filter (where status = 'suppressed')::int as suppressed
      from outreach_messages
    `,
  ]);

  const stats = messageStats[0];
  const active = suppressions.filter((entry) => entry.liftedAt === null);

  return (
    <PageShell>
      <PageHeader
        title="Outreach"
        description={
          <>
        Suppression is matched on the normalised address, so a plus-tag cannot slip
        past a do-not-contact instruction. An opt-out or hard bounce suppresses
        globally, not just for the sequence it arrived on.
          </>
        }
      />

      <AutomationNav />

      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Messages sent</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {Number(stats?.sent ?? 0)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Awaiting approval</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {Number(stats?.drafts ?? 0)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Cancelled by a stop</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {Number(stats?.cancelled ?? 0)}
            </p>
            <p className="text-xs text-muted-foreground">drafts a stop rule voided</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Suppressed contacts</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{active.length}</p>
          </CardContent>
        </Card>
      </section>

      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Sequences</h2>
        {sequences.length === 0 ? (
          <EmptyState
            title="No sequences"
            body="A sequence is created only after a draft's claims have been verified — a message that cannot be supported never becomes a sendable artifact."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Recipient</th>
                  <th className="p-2">Kind</th>
                  <th className="p-2">Client</th>
                  <th className="p-2">Status</th>
                  <th className="p-2 text-right">Step</th>
                  <th className="p-2 text-right">Sent</th>
                  <th className="p-2">Next send</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {sequences.map((sequence) => {
                  const status = sequence.status as string;
                  return (
                    <tr key={sequence.id as string} className="border-t">
                      <td className="p-2 text-xs">
                        {sequence.recipientEmail as string}
                        {(sequence.recipientName as string).length > 0 ? (
                          <span className="text-muted-foreground">
                            {" "}
                            ({sequence.recipientName as string})
                          </span>
                        ) : null}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {sequence.subjectKind as string}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {(sequence.projectName as string | null) ?? "platform"}
                      </td>
                      <td className="p-2">
                        <Badge variant={status === "active" ? "default" : "secondary"}>
                          {STOP_LABEL[status] ?? status}
                        </Badge>
                        {sequence.stopReason !== null ? (
                          <p className="mt-0.5 text-[11px] text-muted-foreground">
                            {sequence.stopReason as string}
                          </p>
                        ) : null}
                      </td>
                      <td className="p-2 text-right tabular-nums text-xs">
                        {Number(sequence.currentStep)}/{Number(sequence.maxSteps)}
                      </td>
                      <td className="p-2 text-right tabular-nums text-xs">
                        {Number(sequence.sent)}
                      </td>
                      <td className="p-2 text-xs text-muted-foreground">
                        {sequence.nextSendAt === null
                          ? "—"
                          : (sequence.nextSendAt as Date)
                              .toISOString()
                              .slice(0, 16)
                              .replace("T", " ")}
                      </td>
                      <td className="p-2">
                        {status === "active" ? (
                          <StopSequenceButton sequenceId={sequence.id as string} />
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-medium">Suppression list</h2>
        {suppressions.length === 0 ? (
          <EmptyState
            title="Nobody is suppressed"
            body="Entries arrive from opt-outs, hard bounces, complaints, client requests, legal requests, and manual operator action. Lifting one is an admin decision with a permanent reason."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Scope</th>
                  <th className="p-2">Matched value</th>
                  <th className="p-2">Reason</th>
                  <th className="p-2">Applies to</th>
                  <th className="p-2">Added</th>
                  <th className="p-2">State</th>
                </tr>
              </thead>
              <tbody>
                {suppressions.map((entry) => (
                  <tr key={entry.id} className="border-t">
                    <td className="p-2 text-xs">{entry.scope}</td>
                    <td className="p-2 font-mono text-xs">{entry.normalizedValue}</td>
                    <td className="p-2 text-xs">{entry.reason.replace(/_/g, " ")}</td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {entry.projectId === null ? "every client" : "one client"}
                    </td>
                    <td className="p-2 text-xs text-muted-foreground">
                      {entry.createdAt.toISOString().slice(0, 10)}
                    </td>
                    <td className="p-2 text-xs">
                      {entry.liftedAt === null ? (
                        <Badge variant="secondary">suppressed</Badge>
                      ) : (
                        <span className="text-muted-foreground">
                          lifted {entry.liftedAt.toISOString().slice(0, 10)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground">
          Lifted entries stay listed. The history of &ldquo;we were asked to stop,
          then un-stopped&rdquo; is exactly what an audit needs.
        </p>
      </section>
    </PageShell>
  );
}
