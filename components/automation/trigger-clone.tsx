"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cloneTriggerForClient } from "@/app/automation/actions";

/** Clone a platform schedule template to one client, enabled (roadmap 2.5).
 * Rendered only for platform-scoped schedule rows; admin-gated server-side. */
export function TriggerClone({
  triggerId,
  projects,
}: {
  triggerId: string;
  projects: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [projectId, setProjectId] = useState("");

  const submit = () => {
    startTransition(async () => {
      const result = await cloneTriggerForClient({ triggerId, projectId });
      if (result.ok) {
        toast.success("Enabled for client — the clone fires on the template's cadence.");
        setProjectId("");
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <div className="flex items-center gap-1.5">
      <Select value={projectId} onValueChange={setProjectId}>
        <SelectTrigger className="h-7 w-40 text-xs">
          <SelectValue placeholder="Enable for client…" />
        </SelectTrigger>
        <SelectContent>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        size="sm"
        variant="outline"
        className="h-7"
        disabled={pending || !projectId}
        onClick={submit}
      >
        {pending ? "…" : "Clone"}
      </Button>
    </div>
  );
}
