"use client";

import { toast } from "sonner";
import { PlugZap } from "lucide-react";
import { testConnectorConnection } from "@/app/automation/actions";
import { Button } from "@/components/ui/button";
import { useAction } from "@/lib/hooks/use-action";

/**
 * Probe a connection for real.
 *
 * Two independent facts are recorded — can we authenticate, and can we read —
 * because they fail for different reasons and need different fixes. A stored
 * credential is not a working integration.
 */
export function TestConnectionButton({ connectionId }: { connectionId: string }) {
  const { pending, run } = useAction();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        run(
          async () => {
            const result = await testConnectorConnection(connectionId);
            if (result.ok) {
              // A completed probe can still report a broken integration —
              // that outcome toasts as an error, so it stays in-component.
              if (result.data.authorizationOk && result.data.readOk) {
                toast.success(result.data.message);
              } else {
                toast.error(result.data.message);
              }
            }
            return result;
          },
          { refresh: true }
        )
      }
    >
      <PlugZap className="mr-1.5 size-3.5" />
      {pending ? "Probing…" : "Test"}
    </Button>
  );
}
