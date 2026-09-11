"use client";

import { setTriggerEnabled } from "@/app/automation/actions";
import { Button } from "@/components/ui/button";
import { useAction } from "@/lib/hooks/use-action";

/** Enabling a trigger is an admin act, and it is audited. */
export function TriggerToggle({
  triggerId,
  enabled,
}: {
  triggerId: string;
  enabled: boolean;
}) {
  const { pending, run } = useAction();

  return (
    <Button
      size="sm"
      variant={enabled ? "outline" : "default"}
      disabled={pending}
      onClick={() =>
        run(() => setTriggerEnabled({ triggerId, enabled: !enabled }), {
          success: enabled ? "Trigger disabled." : "Trigger enabled.",
          refresh: true,
        })
      }
    >
      {pending ? "…" : enabled ? "Disable" : "Enable"}
    </Button>
  );
}
