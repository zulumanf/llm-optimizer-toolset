"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PlugZap } from "lucide-react";
import { testConnectorConnection } from "@/app/automation/actions";
import { Button } from "@/components/ui/button";

/**
 * Probe a connection for real.
 *
 * Two independent facts are recorded — can we authenticate, and can we read —
 * because they fail for different reasons and need different fixes. A stored
 * credential is not a working integration.
 */
export function TestConnectionButton({ connectionId }: { connectionId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await testConnectorConnection(connectionId);
          if (!result.ok) {
            toast.error(result.error.message);
            return;
          }
          if (result.data.authorizationOk && result.data.readOk) {
            toast.success(result.data.message);
          } else {
            toast.error(result.data.message);
          }
          router.refresh();
        })
      }
    >
      <PlugZap className="mr-1.5 size-3.5" />
      {pending ? "Probing…" : "Test"}
    </Button>
  );
}
