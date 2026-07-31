"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { transitionCampaign } from "@/app/campaigns/actions";

export function CampaignTransitions({
  campaignId,
  status,
}: {
  campaignId: string;
  status: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const act = (action: "activate" | "complete" | "abandon") => {
    startTransition(async () => {
      const result = await transitionCampaign({ campaignId, action });
      if (result.ok) {
        toast.success(
          action === "activate"
            ? "Campaign activated — baseline captured."
            : `Campaign ${action === "complete" ? "completed" : "abandoned"}.`
        );
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <div className="flex items-center gap-2">
      {status === "draft" && (
        <Button size="sm" onClick={() => act("activate")} disabled={pending}>
          Activate (captures baseline)
        </Button>
      )}
      {status === "active" && (
        <Button size="sm" onClick={() => act("complete")} disabled={pending}>
          Mark completed
        </Button>
      )}
      {(status === "draft" || status === "active") && (
        <Button
          size="sm"
          variant="outline"
          onClick={() => act("abandon")}
          disabled={pending}
        >
          Abandon
        </Button>
      )}
    </div>
  );
}
