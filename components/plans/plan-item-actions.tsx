"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { ListPlus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { activatePlanItem, dropPlanItem } from "@/app/plans/actions";

/** Turns a plan item into a real, approved task on the client's board and
 * tracks it back to done (plan 5.4). */
export function ActivatePlanItemButton({ planItemId }: { planItemId: string }) {
  const [pending, startTransition] = useTransition();
  const activate = () => {
    startTransition(async () => {
      const result = await activatePlanItem({ planItemId });
      if (result.ok) toast.success("Task created — the item tracks it to done.");
      else toast.error(result.error.message);
    });
  };
  return (
    <Button size="sm" variant="outline" onClick={activate} disabled={pending}>
      <ListPlus className="size-4" /> {pending ? "Creating…" : "Start as task"}
    </Button>
  );
}

export function DropPlanItemButton({ planItemId }: { planItemId: string }) {
  const [pending, startTransition] = useTransition();
  const drop = () => {
    const reason = window.prompt("Why is this item being dropped? (recorded)");
    if (!reason || reason.trim().length === 0) return;
    startTransition(async () => {
      const result = await dropPlanItem({ planItemId, reason });
      if (result.ok) toast.success("Dropped, with the reason on the record.");
      else toast.error(result.error.message);
    });
  };
  return (
    <Button size="sm" variant="ghost" onClick={drop} disabled={pending}>
      <X className="size-4" /> Drop
    </Button>
  );
}
