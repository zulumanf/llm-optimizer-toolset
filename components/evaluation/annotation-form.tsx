"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { recordAnnotationAction } from "@/app/evaluation/actions";

type Choice = "not_same_entity" | "not_mentioned" | "mentioned_only" | "recommended";

const CHOICES: { value: Choice; label: string; hint: string }[] = [
  { value: "recommended", label: "Recommended", hint: "The answer suggests hiring or contacting this company." },
  { value: "mentioned_only", label: "Mentioned, not recommended", hint: "Named, listed neutrally, or discussed without a recommendation." },
  { value: "not_mentioned", label: "Not mentioned", hint: "The company does not appear in the answer." },
  { value: "not_same_entity", label: "Different entity, same name", hint: "The name refers to another person or business." },
];

/** Blind label for one (answer, company) pair. The classifier's label is
 * never shown here (spec 151 A11). */
export function AnnotationForm({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [choice, setChoice] = useState<Choice | null>(null);
  const [notes, setNotes] = useState("");

  const submit = () => {
    if (!choice) return;
    startTransition(async () => {
      const result = await recordAnnotationAction({
        itemId,
        sameEntity: choice !== "not_same_entity",
        mentioned: choice === "mentioned_only" || choice === "recommended",
        recommended: choice === "recommended",
        notes: notes.trim() || undefined,
      });
      if (result.ok) {
        setChoice(null);
        setNotes("");
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <fieldset className="grid gap-3" disabled={pending}>
      <legend className="mb-2 text-sm font-medium">Your label</legend>
      {CHOICES.map((c) => (
        <label key={c.value} className="flex cursor-pointer items-start gap-2 rounded-md border p-3 text-sm focus-within:ring-2 focus-within:ring-ring">
          <input type="radio" name="label" value={c.value} checked={choice === c.value} onChange={() => setChoice(c.value)} className="mt-1" />
          <span>
            <span className="font-medium">{c.label}</span>
            <span className="block text-xs text-muted-foreground">{c.hint}</span>
          </span>
        </label>
      ))}
      <div className="grid gap-1">
        <Label htmlFor="annotation-notes">Notes (optional)</Label>
        <Textarea id="annotation-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
      </div>
      <Button onClick={submit} disabled={!choice || pending} className="justify-self-start">
        {pending ? "Saving…" : "Save and next"}
      </Button>
    </fieldset>
  );
}
