"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCheck, ClipboardCopy, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  syncNotifications,
  markAllRead,
  copyDigest,
} from "@/app/notifications/actions";

export function NotificationsControls() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <div className="flex shrink-0 gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await copyDigest();
            if (!result.ok) {
              toast.error(result.error.message);
              return;
            }
            try {
              await navigator.clipboard.writeText(result.data.text);
              toast.success("Digest copied to the clipboard.");
            } catch {
              toast.error("Clipboard blocked — the digest is in the console.");
              console.log(result.data.text);
            }
          })
        }
      >
        <ClipboardCopy className="size-4" /> Copy digest
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await markAllRead();
            if (result.ok) {
              toast.success(`${result.data.count} marked read.`);
              router.refresh();
            }
          })
        }
      >
        <CheckCheck className="size-4" /> Mark all read
      </Button>
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await syncNotifications();
            if (result.ok) {
              const { created, refreshed, resolved } = result.data;
              toast.success(
                `${created} new · ${refreshed} still open · ${resolved} resolved`
              );
              router.refresh();
            } else {
              toast.error(result.error.message);
            }
          })
        }
      >
        <RefreshCw className="size-4" /> {pending ? "Syncing…" : "Sync"}
      </Button>
    </div>
  );
}
