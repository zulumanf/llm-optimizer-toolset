import { BellOff } from "lucide-react";
import { PageHeader, PageShell } from "@/components/layout/page";
import { listNotifications } from "@/lib/notifications/service";
import { NotificationsControls } from "@/components/notifications/controls";
import { NotificationRow } from "@/components/notifications/row";
import { Badge } from "@/components/ui/badge";
import Link from "next/link";

const FILTERS = ["open", "unread", "resolved", "dismissed", "all"] as const;

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status = "open" } = await searchParams;
  const filter = (FILTERS as readonly string[]).includes(status)
    ? (status as (typeof FILTERS)[number])
    : "open";
  const notifications = await listNotifications({ status: filter });

  return (
    <PageShell>
      <PageHeader
        title="Inbox"
        description="Derived from the live state of every client, not a log of events: an issue that gets fixed closes its own notification, and a persistent one never stacks duplicates. Hygiene items stay on Today — only real work notifies."
        actions={<NotificationsControls />}
      />

      <div className="mb-4 mt-4 flex flex-wrap gap-2 text-sm">
        {FILTERS.map((f) => (
          <Link key={f} href={`?status=${f}`}>
            <Badge variant={filter === f ? "default" : "outline"}>{f}</Badge>
          </Link>
        ))}
      </div>

      {notifications.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed p-12 text-center">
          <BellOff className="size-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {filter === "open"
              ? "Nothing open. Run a sync after the next benchmark to refresh."
              : `No ${filter} notifications.`}
          </p>
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {notifications.map((n) => (
            <NotificationRow
              key={n.id}
              notification={{
                id: n.id,
                kind: n.kind,
                severity: n.severity,
                title: n.title,
                body: n.body,
                href: n.href,
                status: n.status,
              }}
            />
          ))}
        </div>
      )}
    </PageShell>
  );
}
