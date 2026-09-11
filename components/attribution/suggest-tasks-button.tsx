"use client";

import { ListPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/lib/hooks/use-action";
import { suggestTasksFromIntervention } from "@/app/attribution/actions";

interface Props {
  interventionId: string;
  hasNotable: boolean;
}

export function SuggestTasksButton({ interventionId, hasNotable }: Props) {
  const { pending, run } = useAction();
  if (!hasNotable) return null;

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        run(() => suggestTasksFromIntervention({ interventionId }), {
          success: (data) =>
            `${data.created} task${data.created === 1 ? "" : "s"} suggested (awaiting approval).`,
          refresh: true,
        })
      }
    >
      <ListPlus className="size-4" /> Suggest tasks from verdicts
    </Button>
  );
}
