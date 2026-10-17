"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { recordLaborAction } from "@/app/operations/actions";
import { LABOR_ACTIVITY_LABELS } from "@/lib/economics/labels";

const NO_PROJECT = "none";

export function LaborForm({ projects }: { projects: { id: string; name: string }[] }) {
  const [pending, start] = useTransition();
  const [projectId, setProjectId] = useState(NO_PROJECT);
  const [activity, setActivity] = useState("report_review");
  const [minutes, setMinutes] = useState("30");
  const [note, setNote] = useState("");
  const today = new Date().toISOString().slice(0, 10);
  const submit = () =>
    start(async () => {
      const r = await recordLaborAction({
        projectId: projectId === NO_PROJECT ? undefined : projectId,
        activity,
        minutes: Number(minutes),
        occurredOn: today,
        note: note || undefined,
      });
      if (r.ok) {
        toast.success("Time logged.");
        setNote("");
      } else toast.error(r.error.message);
    });
  return (
    <div className="grid gap-3 sm:grid-cols-5 sm:items-end">
      <div className="grid gap-1">
        <Label htmlFor="labor-project">Client</Label>
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger id="labor-project"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_PROJECT}>Not client-specific</SelectItem>
            {projects.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="labor-activity">Activity</Label>
        <Select value={activity} onValueChange={setActivity}>
          <SelectTrigger id="labor-activity"><SelectValue /></SelectTrigger>
          <SelectContent>
            {Object.entries(LABOR_ACTIVITY_LABELS).map(([k, v]) => <SelectItem key={k} value={k}>{v}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="labor-minutes">Minutes</Label>
        <Input id="labor-minutes" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="labor-note">Note</Label>
        <Input id="labor-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <Button onClick={submit} disabled={pending}>{pending ? "Logging…" : "Log time"}</Button>
    </div>
  );
}
