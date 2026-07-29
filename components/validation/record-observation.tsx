"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
import { recordClientValidationObservation } from "@/app/evidence/actions";

interface Props {
  validationRunId: string;
  prompts: { id: string; text: string }[];
}

export function RecordObservationDialog({ validationRunId, prompts }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [promptId, setPromptId] = useState(prompts[0]?.id ?? "");
  const [provider, setProvider] = useState("chatgpt-consumer");
  const [performedOn, setPerformedOn] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [rawResponse, setRawResponse] = useState("");
  const [mentioned, setMentioned] = useState(false);
  const [recommended, setRecommended] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plus className="size-4" /> Record client observation
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Record a client-run observation</DialogTitle>
          <DialogDescription>
            Paste exactly what the client saw. Stored immutably (hashed on
            insert) and kept out of benchmark metrics.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Prompt (as run by the client)</Label>
            <Select value={promptId} onValueChange={setPromptId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select…" />
              </SelectTrigger>
              <SelectContent>
                {prompts.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.text.slice(0, 70)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="vo-provider">Provider / interface</Label>
              <Input
                id="vo-provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="vo-date">Performed on</Label>
              <Input
                id="vo-date"
                type="date"
                value={performedOn}
                onChange={(e) => setPerformedOn(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="vo-text">Exact visible response</Label>
            <Textarea
              id="vo-text"
              rows={6}
              value={rawResponse}
              onChange={(e) => setRawResponse(e.target.value)}
              placeholder="Paste the full answer the client saw…"
            />
          </div>
          <div className="flex gap-6">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={mentioned}
                onChange={(e) => setMentioned(e.target.checked)}
              />
              Client was mentioned
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4"
                checked={recommended}
                onChange={(e) => setRecommended(e.target.checked)}
              />
              Client was recommended
            </label>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            disabled={pending || !promptId || rawResponse.trim().length === 0}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await recordClientValidationObservation({
                  validationRunId,
                  promptId,
                  provider,
                  performedOn,
                  rawResponse,
                  claimedMentioned: mentioned,
                  claimedRecommended: recommended,
                });
                if (result.ok) {
                  toast.success("Client observation recorded (immutable).");
                  setRawResponse("");
                  setOpen(false);
                  router.refresh();
                } else {
                  setError(result.error.message);
                }
              })
            }
          >
            {pending ? "Saving…" : "Record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
