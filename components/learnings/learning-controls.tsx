"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
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
import {
  recordLearningAction,
  retireLearningAction,
} from "@/app/learnings/actions";
import {
  LEARNING_CATEGORIES,
  LEARNING_CONFIDENCE_LABELS,
} from "@/lib/learnings/service";

/** Record dialog (spec 058). Strong confidence labels need measured source
 * outcomes — the service refuses otherwise, and that refusal is the
 * integrity feature, not a bug to route around. */
export function RecordLearningDialog() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [statement, setStatement] = useState("");
  const [rationale, setRationale] = useState("");
  const [category, setCategory] = useState<string>("content");
  const [confidenceLabel, setConfidenceLabel] = useState<string>("probable");
  const [direction, setDirection] = useState<string>("supports");
  const [playKey, setPlayKey] = useState("");
  const [gapType, setGapType] = useState("");
  const [outcomeIds, setOutcomeIds] = useState("");

  const submit = () =>
    startTransition(async () => {
      const result = await recordLearningAction({
        statement,
        rationale,
        category,
        confidenceLabel,
        direction,
        playKey: playKey || undefined,
        gapType: gapType || undefined,
        sourceActionOutcomeIds: outcomeIds
          .split(/[\s,]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      });
      if (result.ok) {
        toast.success("Learning recorded.");
        setOpen(false);
        setStatement("");
        setRationale("");
        setOutcomeIds("");
      } else {
        toast.error(result.error.message);
      }
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> Record learning
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record a learning</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="learning-statement">What did we learn?</Label>
            <Textarea
              id="learning-statement"
              value={statement}
              onChange={(e) => setStatement(e.target.value)}
              placeholder="Directory profile cleanup moved recommendation rate for boutique teams within 6 weeks."
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="learning-rationale">Why do we believe it?</Label>
            <Textarea
              id="learning-rationale"
              value={rationale}
              onChange={(e) => setRationale(e.target.value)}
              placeholder="Which measured outcomes back this up, and what they showed."
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="learning-category">Category</Label>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger id="learning-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEARNING_CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="learning-confidence">Confidence</Label>
              <Select value={confidenceLabel} onValueChange={setConfidenceLabel}>
                <SelectTrigger id="learning-confidence">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEARNING_CONFIDENCE_LABELS.map((c) => (
                    <SelectItem key={c} value={c}>
                      {c.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="learning-direction">For its play, this…</Label>
              <Select value={direction} onValueChange={setDirection}>
                <SelectTrigger id="learning-direction">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="supports">supports repeating it</SelectItem>
                  <SelectItem value="cautions">cautions against it</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="learning-play">Play key (optional)</Label>
              <Input
                id="learning-play"
                value={playKey}
                onChange={(e) => setPlayKey(e.target.value)}
                placeholder="claim_directory_profiles"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="learning-gap">Gap type (optional)</Label>
            <Input
              id="learning-gap"
              value={gapType}
              onChange={(e) => setGapType(e.target.value)}
              placeholder="citation"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="learning-outcomes">
              Source outcome IDs (required for confirmed / strongly supported)
            </Label>
            <Input
              id="learning-outcomes"
              value={outcomeIds}
              onChange={(e) => setOutcomeIds(e.target.value)}
              placeholder="Comma-separated action outcome IDs"
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending || statement.trim().length === 0}>
            {pending ? "Recording…" : "Record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RetireLearningButton({ learningId }: { learningId: string }) {
  const [pending, startTransition] = useTransition();
  const retire = () => {
    const reason = window.prompt(
      "Why is this learning retired? (kept as history with this reason)"
    );
    if (!reason || reason.trim().length === 0) return;
    startTransition(async () => {
      const result = await retireLearningAction({ id: learningId, reason });
      if (result.ok) toast.success("Retired.");
      else toast.error(result.error.message);
    });
  };
  return (
    <Button variant="outline" size="sm" onClick={retire} disabled={pending}>
      Retire
    </Button>
  );
}
