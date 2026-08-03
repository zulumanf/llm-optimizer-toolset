"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { setInterventionVisibility } from "@/app/attribution/actions";

/**
 * Portal visibility toggle (plan 4.1). Deny-by-default: an intervention
 * reaches the client portal only after an operator flips it here, the same
 * contract as tasks.client_visible.
 */
export function InterventionVisibilityToggle({
  interventionId,
  clientVisible,
}: {
  interventionId: string;
  clientVisible: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const toggle = () => {
    startTransition(async () => {
      const result = await setInterventionVisibility({
        interventionId,
        clientVisible: !clientVisible,
      });
      if (result.ok) {
        toast.success(
          result.data.clientVisible
            ? "Now visible in the client portal."
            : "Hidden from the client portal."
        );
      } else {
        toast.error(result.error.message);
      }
    });
  };
  return (
    <Button size="sm" variant="ghost" onClick={toggle} disabled={pending}>
      {clientVisible ? (
        <>
          <Eye className="size-4" /> Client sees it
        </>
      ) : (
        <>
          <EyeOff className="size-4" /> Internal only
        </>
      )}
    </Button>
  );
}
