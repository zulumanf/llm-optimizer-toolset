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
import { generateBrief } from "@/app/control-tower/actions";

/** On-demand monthly/quarterly executive briefs (roadmap 3.4) over the
 * previous full period. A gate refusal surfaces verbatim — it is the
 * product working, not an error to retry. */
export function BriefGenerator({
  projects,
}: {
  projects: { id: string; name: string }[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [projectId, setProjectId] = useState("");
  const [kind, setKind] = useState<"monthly" | "quarterly">("monthly");

  const submit = () => {
    startTransition(async () => {
      const result = await generateBrief({ projectId, kind });
      if (result.ok) {
        toast.success(
          result.data.briefId
            ? `${kind} brief generated.`
            : `A ${kind} brief for this period already exists.`
        );
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={projectId} onValueChange={setProjectId}>
        <SelectTrigger className="h-8 w-48 text-sm">
          <SelectValue placeholder="Client…" />
        </SelectTrigger>
        <SelectContent>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select value={kind} onValueChange={(v) => setKind(v as typeof kind)}>
        <SelectTrigger className="h-8 w-32 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="monthly">Monthly</SelectItem>
          <SelectItem value="quarterly">Quarterly</SelectItem>
        </SelectContent>
      </Select>
      <Button size="sm" disabled={pending || !projectId} onClick={submit}>
        {pending ? "Generating…" : "Generate brief (previous period)"}
      </Button>
    </div>
  );
}
