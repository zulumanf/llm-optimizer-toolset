"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowUpDown, Archive } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  archiveCompetitor,
  updateCompetitorTier,
} from "@/app/competitors/actions";

interface Props {
  competitorId: string;
  tier: string;
}

export function CompetitorRowControls({ competitorId, tier }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const act = (fn: () => Promise<{ ok: boolean; error?: { message: string } }>) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) router.refresh();
      else toast.error(result.error?.message ?? "Action failed.");
    });

  return (
    <div className="flex justify-end gap-0.5">
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Toggle tier"
        title="Toggle primary/secondary"
        disabled={pending}
        onClick={() =>
          act(() =>
            updateCompetitorTier({
              competitorId,
              tier: tier === "primary" ? "secondary" : "primary",
            })
          )
        }
      >
        <ArrowUpDown className="size-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Stop tracking"
        title="Stop tracking (history preserved)"
        disabled={pending}
        onClick={() => act(() => archiveCompetitor({ competitorId }))}
      >
        <Archive className="size-4" />
      </Button>
    </div>
  );
}
