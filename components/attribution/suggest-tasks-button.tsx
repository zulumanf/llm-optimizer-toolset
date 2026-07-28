"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ListPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { suggestTasksFromIntervention } from "@/app/attribution/actions";

interface Props {
  interventionId: string;
  hasNotable: boolean;
}

export function SuggestTasksButton({ interventionId, hasNotable }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  if (!hasNotable) return null;

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await suggestTasksFromIntervention({ interventionId });
          if (result.ok) {
            toast.success(
              `${result.data.created} task${result.data.created === 1 ? "" : "s"} suggested (awaiting approval).`
            );
            router.refresh();
          } else {
            toast.error(result.error.message);
          }
        })
      }
    >
      <ListPlus className="size-4" /> Suggest tasks from verdicts
    </Button>
  );
}
