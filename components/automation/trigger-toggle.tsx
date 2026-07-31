"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { setTriggerEnabled } from "@/app/automation/actions";
import { Button } from "@/components/ui/button";

/** Enabling a trigger is an admin act, and it is audited. */
export function TriggerToggle({
  triggerId,
  enabled,
}: {
  triggerId: string;
  enabled: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant={enabled ? "outline" : "default"}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await setTriggerEnabled({ triggerId, enabled: !enabled });
          if (!result.ok) {
            toast.error(result.error.message);
            return;
          }
          toast.success(enabled ? "Trigger disabled." : "Trigger enabled.");
          router.refresh();
        })
      }
    >
      {pending ? "…" : enabled ? "Disable" : "Enable"}
    </Button>
  );
}
