"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { requestTechnicalScan } from "@/app/technical/actions";

export function ScanButton({ projectId }: { projectId: string }) {
  const [pending, startTransition] = useTransition();
  const submit = () => {
    startTransition(async () => {
      const result = await requestTechnicalScan({ projectId });
      if (result.ok) {
        toast.success("Scan queued — the worker will report back here.");
      } else {
        toast.error(result.error.message);
      }
    });
  };
  return (
    <Button variant="outline" size="sm" onClick={submit} disabled={pending}>
      <Radar className="size-4" /> {pending ? "Queueing…" : "Run scan"}
    </Button>
  );
}
