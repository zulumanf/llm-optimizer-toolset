"use client";

import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { setNotificationStatus } from "@/app/notifications/actions";

const SEVERITY_VARIANT = {
  urgent: "destructive",
  attention: "default",
  info: "outline",
} as const;

interface Props {
  notification: {
    id: string;
    kind: string;
    severity: "urgent" | "attention" | "info";
    title: string;
    body: string;
    href: string | null;
    status: string;
  };
}

export function NotificationRow({ notification }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const open = notification.status === "unread" || notification.status === "read";

  const act = (status: "read" | "dismissed", done: string) =>
    startTransition(async () => {
      const result = await setNotificationStatus({
        notificationId: notification.id,
        status,
      });
      if (result.ok) {
        toast.success(done);
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });

  return (
    <div
      className={`flex items-start gap-3 p-3 ${
        notification.status === "unread" ? "bg-accent/30" : ""
      }`}
    >
      <Badge
        variant={SEVERITY_VARIANT[notification.severity]}
        className="mt-0.5 shrink-0"
      >
        {notification.kind.replace(/_/g, " ")}
      </Badge>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">
          {notification.title}
          {notification.status === "resolved" && (
            <span className="ml-2 text-xs font-normal text-success">resolved</span>
          )}
          {notification.status === "dismissed" && (
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              dismissed
            </span>
          )}
        </p>
        <p className="text-sm text-muted-foreground">{notification.body}</p>
        {notification.href && (
          <Link
            href={notification.href}
            className="mt-1 inline-block text-xs underline text-muted-foreground hover:text-foreground"
          >
            go to it
          </Link>
        )}
      </div>
      {open && (
        <div className="flex shrink-0 gap-1">
          {notification.status === "unread" && (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => act("read", "Marked read.")}
            >
              Read
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() => act("dismissed", "Dismissed — it won't come back.")}
          >
            Dismiss
          </Button>
        </div>
      )}
    </div>
  );
}
