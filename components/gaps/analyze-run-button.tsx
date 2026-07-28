"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { analyzeRun } from "@/app/gaps/actions";

export function AnalyzeRunButton({ runId, runLabel }: { runId: string; runLabel: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await analyzeRun({ runId });
          if (result.ok) {
            toast.success(`${result.data.findings} findings from "${runLabel}".`);
            router.refresh();
          } else {
            toast.error(result.error.message);
          }
        })
      }
    >
      <ScanSearch className="size-4" />
      {pending ? "Analyzing…" : `Analyze "${runLabel}"`}
    </Button>
  );
}
