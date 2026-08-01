"use client";

/**
 * Instruction write path (D3, docs/pilot-launch-plan.md).
 *
 * The versioned instruction layer was schema-complete with nothing writing
 * to it: in production the table was empty, every drafting packet emitted
 * `missing_instruction`, and content generated with no brand-voice or
 * prohibited-claim rules. This is the create / revise / approve surface.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  approveInstructionVersion,
  createInstruction,
  reviseInstruction,
} from "@/app/knowledge/actions";

/** Mirrors INSTRUCTION_TYPES in lib/knowledge/instructions/service.ts —
 * the server validates against the authoritative list. */
const TYPE_OPTIONS = [
  "brand_voice",
  "tone",
  "prohibited_claim",
  "preferred_positioning",
  "content_quality",
  "confidentiality",
  "privacy_policy",
  "evidence_policy",
  "attribution_policy",
  "escalation_policy",
  "approval_rule",
];

export function NewInstructionForm({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("brand_voice");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () =>
    startTransition(async () => {
      const result = await createInstruction({
        projectId,
        instructionType: type,
        scope: "project",
        title,
        body,
      });
      if (result.ok) {
        toast.success("Instruction active — packets pick it up immediately.");
        setOpen(false);
        setTitle("");
        setBody("");
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        New instruction
      </Button>
    );
  }

  return (
    <div className="mb-4 space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap gap-3">
        <div>
          <Label className="text-xs">Type</Label>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="mt-1 h-9 w-56 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPE_OPTIONS.map((option) => (
                <SelectItem key={option} value={option} className="text-xs">
                  {option.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="min-w-64 flex-1">
          <Label htmlFor="instruction-title" className="text-xs">
            Title
          </Label>
          <Input
            id="instruction-title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="e.g. Lead with Jersey City before Hoboken"
            className="mt-1 h-9 text-sm"
          />
        </div>
      </div>
      <div>
        <Label htmlFor="instruction-body" className="text-xs">
          Rule (a rule, not a fact — facts belong in Claims)
        </Label>
        <Textarea
          id="instruction-body"
          value={body}
          onChange={(event) => setBody(event.target.value)}
          rows={3}
          placeholder="What must every agent working for this client do or never do?"
          className="mt-1 text-sm"
        />
      </div>
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={submit}
          disabled={pending || title.trim().length === 0 || body.trim().length === 0}
        >
          {pending ? "Saving…" : "Create"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ReviseInstruction({
  instructionId,
  currentBody,
}: {
  instructionId: string;
  currentBody: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState(currentBody);
  const [changeReason, setChangeReason] = useState("");
  const [pending, startTransition] = useTransition();

  const submit = () =>
    startTransition(async () => {
      const result = await reviseInstruction({ instructionId, body, changeReason });
      if (result.ok) {
        toast.success("Revised — a new immutable version is now active.");
        setOpen(false);
        setChangeReason("");
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
      >
        Revise
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border p-2">
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={3}
        className="text-sm"
      />
      <Input
        value={changeReason}
        onChange={(event) => setChangeReason(event.target.value)}
        placeholder="Why is it changing? (recorded on the version)"
        className="h-8 text-xs"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={submit}
          disabled={pending || body.trim().length === 0 || changeReason.trim().length === 0}
        >
          {pending ? "Saving…" : "Save new version"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function ApproveInstructionButton({ versionId }: { versionId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 text-xs"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await approveInstructionVersion({ versionId });
          if (result.ok) {
            toast.success("Approved — the rule now governs.");
            router.refresh();
          } else {
            toast.error(result.error.message);
          }
        })
      }
    >
      {pending ? "Approving…" : "Approve"}
    </Button>
  );
}
