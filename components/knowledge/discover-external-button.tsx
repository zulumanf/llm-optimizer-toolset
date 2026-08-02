"use client";

/**
 * Kick off an external-discovery crawl (spec 027, wired). Confirmation
 * dialog because this spends real provider money (searches + claim
 * extraction) and fetches third-party pages — an operator should mean it.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { requestExternalDiscovery } from "@/app/knowledge/actions";

export function DiscoverExternalButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Globe className="size-4" /> Discover external sources
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Run external discovery?</AlertDialogTitle>
          <AlertDialogDescription>
            Searches the open web for pages about this client (templated
            queries, robots-respecting fetches, cost-capped), stores what it
            finds as immutable sources, and proposes claims for your review.
            Spends real provider tokens; runs in the worker.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await requestExternalDiscovery({ projectId });
                if (result.ok) {
                  toast.success(
                    "Discovery queued — the run summary appears below when the worker picks it up."
                  );
                  setOpen(false);
                  router.refresh();
                } else {
                  toast.error(result.error.message);
                }
              })
            }
          >
            {pending ? "Queuing…" : "Run discovery"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
