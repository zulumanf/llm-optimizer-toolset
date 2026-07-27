"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { updateReportNarrative } from "@/app/reports/actions";
import type { NarrativeSection } from "@/lib/reports/types";

interface Props {
  reportId: string;
  sectionKey: NarrativeSection;
  initial: string;
}

export function NarrativeEditor({ reportId, sectionKey, initial }: Props) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [pending, startTransition] = useTransition();
  const dirty = value !== initial;

  return (
    <div className="space-y-2">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={Math.min(12, Math.max(4, value.split("\n").length + 1))}
        className="font-mono text-sm"
      />
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Sentences with numbers must cite [score:…] or [response:…] — the
          publish gate enforces it.
        </p>
        {dirty && (
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await updateReportNarrative({
                  reportId,
                  sectionKey,
                  markdown: value,
                });
                if (result.ok) {
                  toast.success("Section saved.");
                  router.refresh();
                } else {
                  toast.error(result.error.message);
                }
              })
            }
          >
            {pending ? "Saving…" : "Save section"}
          </Button>
        )}
      </div>
    </div>
  );
}
