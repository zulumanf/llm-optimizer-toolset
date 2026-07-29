/**
 * Notifications (docs/17 B2) — the shared delivery primitive.
 *
 * Derived, not emitted: a sync recomputes the current attention state and
 * reconciles it against stored rows. That means notifications describe what
 * is true NOW, not a history of every scan — an issue that resolves itself
 * closes its own notification, and an issue that persists does not stack
 * duplicates. Reputation alerts, approval queues, and (later) report
 * delivery all ride on this one table.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { writeAudit } from "@/db/audit";
import type { CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { attentionFeed, type Severity } from "@/db/operations";
import { log } from "@/lib/logger";

/** Hygiene items stay in the Today console; only real work notifies —
 * otherwise the inbox trains you to ignore it. */
const NOTIFY_SEVERITIES: Severity[] = ["urgent", "attention"];

export interface Notification {
  id: string;
  projectId: string | null;
  kind: string;
  severity: Severity;
  title: string;
  body: string;
  href: string | null;
  status: "unread" | "read" | "resolved" | "dismissed";
  firstSeenAt: Date;
  lastSeenAt: Date;
}

const COLUMNS = sql`id, project_id, kind, severity, title, body, href, status,
  first_seen_at, last_seen_at`;

export interface SyncResult {
  created: number;
  refreshed: number;
  resolved: number;
}

/**
 * Reconcile notifications with the live attention feed. Idempotent: running
 * it twice in a row creates nothing new and resolves nothing twice.
 */
export async function syncNotifications(): Promise<SyncResult> {
  const { items } = await attentionFeed();
  const notifiable = items.filter((i) => NOTIFY_SEVERITIES.includes(i.severity));

  const seenKeys = new Set<string>();
  let created = 0;
  let refreshed = 0;

  for (const item of notifiable) {
    const dedupeKey = `${item.projectId}:${item.kind}`;
    seenKeys.add(dedupeKey);
    const [row] = await sql`
      insert into notifications
        (project_id, kind, severity, title, body, href, dedupe_key)
      values
        (${item.projectId}, ${item.kind}, ${item.severity},
         ${item.projectName}, ${item.detail}, ${item.href}, ${dedupeKey})
      on conflict (dedupe_key) do update set
        -- Refresh the description and re-open anything that had resolved
        body = excluded.body,
        severity = excluded.severity,
        last_seen_at = now(),
        status = case
          when notifications.status = 'resolved' then 'unread'
          else notifications.status
        end,
        resolved_at = null
      returning (xmax = 0) as inserted
    `;
    if (row?.inserted) created += 1;
    else refreshed += 1;
  }

  // Anything previously open that no longer appears has been dealt with
  const resolvedRows =
    seenKeys.size > 0
      ? await sql`
          update notifications set status = 'resolved', resolved_at = now()
          where status in ('unread', 'read')
            and dedupe_key != all(${[...seenKeys]})
          returning id
        `
      : await sql`
          update notifications set status = 'resolved', resolved_at = now()
          where status in ('unread', 'read')
          returning id
        `;

  const result = { created, refreshed, resolved: resolvedRows.length };
  log("info", "notifications.synced", result);
  return result;
}

export async function listNotifications(opts: {
  status?: "unread" | "read" | "resolved" | "dismissed" | "open" | "all";
  limit?: number;
}): Promise<Notification[]> {
  const status = opts.status ?? "open";
  const limit = opts.limit ?? 100;
  if (status === "open") {
    return sql<Notification[]>`
      select ${COLUMNS} from notifications
      where status in ('unread', 'read')
      order by case severity when 'urgent' then 0 when 'attention' then 1 else 2 end,
        (status = 'unread') desc, last_seen_at desc
      limit ${limit}
    `;
  }
  if (status === "all") {
    return sql<Notification[]>`
      select ${COLUMNS} from notifications
      order by last_seen_at desc limit ${limit}
    `;
  }
  return sql<Notification[]>`
    select ${COLUMNS} from notifications where status = ${status}
    order by last_seen_at desc limit ${limit}
  `;
}

export async function unreadCount(): Promise<number> {
  const [row] = await sql`
    select count(*)::int as n from notifications where status = 'unread'
  `;
  return (row?.n as number) ?? 0;
}

const statusSchema = z.object({
  notificationId: z.string().uuid(),
  // "unread" is the undo path for a dismissal (UX)
  status: z.enum(["read", "dismissed", "unread"]),
});

export async function setNotificationStatus(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<{ notificationId: string }>> {
  const parsed = statusSchema.safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid input."));
  }
  const { notificationId, status } = parsed.data;
  try {
    const allowedFrom =
      status === "unread"
        ? ["dismissed", "read"]
        : ["unread", "read"];
    const [row] = await sql`
      update notifications set status = ${status},
        read_at = case when ${status} = 'read' then now() else read_at end
      where id = ${notificationId} and status = any(${allowedFrom})
      returning id, kind
    `;
    if (!row) {
      return fail(
        new ClassifiedError("conflict", "Notification is not in a state that allows that.")
      );
    }
    // Dismissal is a deliberate "I know, stop telling me" — worth auditing;
    // marking read is routine and is not.
    if (status === "dismissed") {
      await sql.begin((tx) =>
        writeAudit(tx, {
          userId: user.id,
          action: "notification.dismiss",
          entity: "notification",
          entityId: notificationId,
          detail: { kind: row.kind as string },
        })
      );
    }
    return ok({ notificationId });
  } catch (err) {
    return fail(err);
  }
}

export async function markAllRead(): Promise<number> {
  const rows = await sql`
    update notifications set status = 'read', read_at = now()
    where status = 'unread' returning id
  `;
  return rows.length;
}

/**
 * Plain-text digest of what is open — the payload a future email/Slack
 * delivery sends, and useful today as a copy-pasteable stand-up summary.
 */
export async function digestText(): Promise<string> {
  const open = await listNotifications({ status: "open", limit: 50 });
  if (open.length === 0) return "Nothing open across all clients.";
  const urgent = open.filter((n) => n.severity === "urgent");
  const attention = open.filter((n) => n.severity === "attention");
  const section = (title: string, rows: Notification[]) =>
    rows.length === 0
      ? ""
      : [`${title} (${rows.length})`, ...rows.map((n) => `- ${n.title}: ${n.body}`)].join(
          "\n"
        );
  return [section("URGENT", urgent), section("NEEDS A DECISION", attention)]
    .filter(Boolean)
    .join("\n\n");
}
