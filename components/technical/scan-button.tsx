"use client";

import { Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAction } from "@/lib/hooks/use-action";
import { requestTechnicalScan } from "@/app/technical/actions";

export function ScanButton({ projectId }: { projectId: string }) {
  const { pending, run } = useAction();
  const submit = () =>
    run(() => requestTechnicalScan({ projectId }), {
      success: "Scan queued — the worker will report back here.",
    });
  return (
    <Button variant="outline" size="sm" onClick={submit} disabled={pending}>
      <Radar className="size-4" /> {pending ? "Queueing…" : "Run scan"}
    </Button>
  );
}
