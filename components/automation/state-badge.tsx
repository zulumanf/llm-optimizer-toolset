import { Badge } from "@/components/ui/badge";

/**
 * Workflow/node state, coloured by what it means for an operator rather than by
 * severity alone: a safe stop is not a failure, and `partially_completed` is a
 * disclosure that needs a decision.
 */
const VARIANT: Record<string, "default" | "destructive" | "outline" | "secondary"> = {
  queued: "outline",
  initializing: "default",
  running: "default",
  waiting_for_dependency: "secondary",
  waiting_for_approval: "secondary",
  waiting_for_external_system: "secondary",
  completed: "outline",
  partially_completed: "secondary",
  failed: "destructive",
  cancelled: "outline",
  safely_stopped: "secondary",
  timed_out: "destructive",
  // node states
  pending: "outline",
  ready: "outline",
  succeeded: "outline",
  failed_retryable: "secondary",
  failed_terminal: "destructive",
  awaiting_verification: "secondary",
  awaiting_approval: "secondary",
  skipped: "outline",
};

export function StateBadge({ state }: { state: string }) {
  return (
    <Badge variant={VARIANT[state] ?? "outline"} className="font-normal">
      {state.replace(/_/g, " ")}
    </Badge>
  );
}
