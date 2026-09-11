"use client";

import { RotateCcw } from "lucide-react";
import { retryAutomationNode } from "@/app/automation/actions";
import { Button } from "@/components/ui/button";
import { useAction } from "@/lib/hooks/use-action";

/**
 * Re-arm a failed node. Safe by construction: the (run, node, fan_key) unique
 * index means a retry cannot duplicate work that already settled.
 */
export function RetryNodeButton({ nodeRunId }: { nodeRunId: string }) {
  const { pending, run } = useAction();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        run(() => retryAutomationNode(nodeRunId), {
          success: "Node re-armed. The next tick picks it up.",
          refresh: true,
        })
      }
    >
      <RotateCcw className="mr-1.5 size-3.5" />
      {pending ? "Retrying…" : "Retry node"}
    </Button>
  );
}
