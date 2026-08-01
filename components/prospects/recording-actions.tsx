"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Clapperboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { generateRecordingPlan, setRecordingStatus } from "@/app/prospects/actions";
import { RECORDING_STATUSES } from "@/lib/prospects/constants";

export function GenerateRecordingButton({ prospectId }: { prospectId: string }) {
  const [pending, startTransition] = useTransition();
  const generate = () => {
    startTransition(async () => {
      const result = await generateRecordingPlan({ prospectId });
      if (result.ok) toast.success("Recording plan generated.");
      else toast.error(result.error.message);
    });
  };
  return (
    <Button size="sm" variant="outline" onClick={generate} disabled={pending}>
      <Clapperboard className="size-4" /> {pending ? "Generating…" : "Generate recording plan"}
    </Button>
  );
}

export function RecordingStatusSelect({
  planId,
  status,
}: {
  planId: string;
  status: string;
}) {
  const [pending, startTransition] = useTransition();
  const update = (next: string) => {
    startTransition(async () => {
      const result = await setRecordingStatus({ planId, status: next });
      if (result.ok) toast.success("Recording status updated.");
      else toast.error(result.error.message);
    });
  };
  return (
    <Select value={status} onValueChange={update} disabled={pending}>
      <SelectTrigger className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {RECORDING_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {s.replaceAll("_", " ")}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
