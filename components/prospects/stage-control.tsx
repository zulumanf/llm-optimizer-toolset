"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { addActivityNote, transitionStage } from "@/app/prospects/actions";
import { ALL_PROSPECT_STAGES } from "@/lib/prospects/constants";

export function StageControl({
  prospectId,
  currentStage,
}: {
  prospectId: string;
  currentStage: string;
}) {
  const [pending, startTransition] = useTransition();
  const [toStage, setToStage] = useState("");
  const [override, setOverride] = useState(false);
  const [rationale, setRationale] = useState("");

  const move = () => {
    startTransition(async () => {
      const result = await transitionStage({
        prospectId,
        toStage,
        override,
        overrideRationale: rationale || undefined,
      });
      if (result.ok) {
        toast.success(`Moved to ${toStage.replaceAll("_", " ")}.`);
        setToStage("");
        setOverride(false);
        setRationale("");
      } else {
        toast.error(result.error.message);
        // A blocked verdict is overridable by an admin with a written reason.
        if (result.error.kind === "conflict") setOverride(true);
      }
    });
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select value={toStage} onValueChange={setToStage}>
        <SelectTrigger className="w-52">
          <SelectValue placeholder={`Stage: ${currentStage.replaceAll("_", " ")}`} />
        </SelectTrigger>
        <SelectContent>
          {ALL_PROSPECT_STAGES.filter((s) => s !== currentStage).map((s) => (
            <SelectItem key={s} value={s}>
              {s.replaceAll("_", " ")}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {override && (
        <Input
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Admin override rationale (required)"
          className="w-72"
        />
      )}
      <Button
        size="sm"
        onClick={move}
        disabled={pending || !toStage || (override && !rationale.trim())}
        variant={override ? "destructive" : "default"}
      >
        {pending ? "Moving…" : override ? "Override conflict & move" : "Move stage"}
      </Button>
    </div>
  );
}

export function NoteForm({ prospectId }: { prospectId: string }) {
  const [pending, startTransition] = useTransition();
  const [note, setNote] = useState("");
  const submit = () => {
    startTransition(async () => {
      const result = await addActivityNote({ prospectId, note });
      if (result.ok) {
        toast.success("Note added.");
        setNote("");
      } else toast.error(result.error.message);
    });
  };
  return (
    <div className="flex items-center gap-2">
      <Input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Add a manual activity note…"
      />
      <Button size="sm" variant="outline" onClick={submit} disabled={pending || !note.trim()}>
        Add note
      </Button>
    </div>
  );
}
