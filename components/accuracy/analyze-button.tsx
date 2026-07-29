"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { analyzeRunAccuracy } from "@/app/accuracy/actions";

export function AnalyzeAccuracyButton({
  runId,
  runLabel,
}: {
  runId: string;
  runLabel: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await analyzeRunAccuracy({ runId });
          if (result.ok) {
            const { findings, checked, rejected } = result.data;
            toast.success(
              `${findings} finding${findings === 1 ? "" : "s"} from ${checked} answer${checked === 1 ? "" : "s"}` +
                (rejected > 0 ? ` · ${rejected} unquotable claim(s) rejected` : "")
            );
            router.refresh();
          } else {
            toast.error(result.error.message);
          }
        })
      }
    >
      <ShieldAlert className="size-4" />
      {pending ? "Auditing…" : `Analyze "${runLabel}"`}
    </Button>
  );
}
