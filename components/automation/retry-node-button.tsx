"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RotateCcw } from "lucide-react";
import { retryAutomationNode } from "@/app/automation/actions";
import { Button } from "@/components/ui/button";

/**
 * Re-arm a failed node. Safe by construction: the (run, node, fan_key) unique
 * index means a retry cannot duplicate work that already settled.
 */
export function RetryNodeButton({ nodeRunId }: { nodeRunId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await retryAutomationNode(nodeRunId);
          if (!result.ok) {
            toast.error(result.error.message);
            return;
          }
          toast.success("Node re-armed. The next tick picks it up.");
          router.refresh();
        })
      }
    >
      <RotateCcw className="mr-1.5 size-3.5" />
      {pending ? "Retrying…" : "Retry node"}
    </Button>
  );
}
