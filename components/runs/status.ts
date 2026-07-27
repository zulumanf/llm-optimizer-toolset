import type { RunStatus } from "@/db/runs";

export function runStatusVariant(
  status: RunStatus
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "completed":
      return "default";
    case "running":
    case "pending":
      return "secondary";
    case "failed":
      return "destructive";
    case "partial":
      return "outline";
  }
}
