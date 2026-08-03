"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ClipboardList } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { recordAssessment } from "@/app/prospects/actions";
import { ASSESSMENT_ITEMS, ASSESSMENT_VALUES } from "@/lib/prospects/constants";

export function AssessmentChecklist({
  prospectId,
  answers,
}: {
  prospectId: string;
  answers: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [local, setLocal] = useState<Record<string, string>>(answers);

  const record = (item: string, value: string) => {
    setLocal((prev) => ({ ...prev, [item]: value }));
    startTransition(async () => {
      const result = await recordAssessment({ prospectId, item, value });
      if (!result.ok) {
        toast.error(result.error.message);
        setLocal((prev) => ({ ...prev, [item]: answers[item] ?? "" }));
      }
    });
  };

  const answered = Object.values(local).filter(
    (v) => v === "yes" || v === "no" || v === "unknown"
  ).length;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ClipboardList className="size-4" /> Assessment ({answered}/{ASSESSMENT_ITEMS.length})
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Fixability assessment</DialogTitle>
        </DialogHeader>
        <p className="text-xs text-muted-foreground">
          Operator-recorded facts the platform cannot derive. Answers save immediately;
          “unknown” is a recorded answer, unanswered items read “not measured”. Recompute
          the score after changing answers.
        </p>
        <ul className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {ASSESSMENT_ITEMS.map((item) => (
            <li key={item} className="flex items-center justify-between gap-3 text-sm">
              <span>{item.replaceAll("_", " ")}</span>
              <Select
                value={local[item] ?? ""}
                onValueChange={(value) => record(item, value)}
                disabled={pending}
              >
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  {ASSESSMENT_VALUES.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
