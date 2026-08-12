"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronUp, RefreshCw, ScanSearch } from "lucide-react";
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
  discoverOpportunitiesAction,
  requestPresenceCheckAction,
  updateOpportunityAction,
} from "@/app/projects/[id]/citations/actions";
import {
  ACQUISITION_PATHS,
  OPPORTUNITY_STATUSES,
} from "@/lib/citations/constants";

export function DiscoverButton({ projectId }: { projectId: string }) {
  const [pending, startTransition] = useTransition();
  const discover = () =>
    startTransition(async () => {
      const result = await discoverOpportunitiesAction({ projectId });
      if (result.ok) {
        toast.success(
          `${result.data.discovered} new source(s) discovered, ${result.data.rescored} rescored.`
        );
      } else {
        toast.error(result.error.message);
      }
    });
  return (
    <Button size="sm" onClick={discover} disabled={pending}>
      <RefreshCw className="size-4" />
      {pending ? "Scanning ledger…" : "Discover & rescore"}
    </Button>
  );
}

export function PresenceCheckButton({ opportunityId }: { opportunityId: string }) {
  const [pending, startTransition] = useTransition();
  const check = () =>
    startTransition(async () => {
      const result = await requestPresenceCheckAction({ opportunityId });
      if (result.ok) {
        toast.success(`Presence check queued for ${result.data.domain}.`);
      } else {
        toast.error(result.error.message);
      }
    });
  return (
    <Button variant="outline" size="sm" onClick={check} disabled={pending}>
      <ScanSearch className="size-4" /> Check presence
    </Button>
  );
}

/** Expandable "why this score" — the stored explanation lines, verbatim. */
export function ExplanationToggle({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  if (lines.length === 0) return null;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
        Why this score
      </button>
      {open && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ManageProps {
  opportunityId: string;
  domain: string;
  status: string;
  acquisitionPath: string;
  acquisitionDifficulty: string;
  nextAction: string | null;
}

export function ManageOpportunityDialog(props: ManageProps) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [status, setStatus] = useState(props.status);
  const [path, setPath] = useState(props.acquisitionPath);
  const [difficulty, setDifficulty] = useState(props.acquisitionDifficulty);
  const [nextAction, setNextAction] = useState(props.nextAction ?? "");
  const [notes, setNotes] = useState("");

  const submit = () =>
    startTransition(async () => {
      const result = await updateOpportunityAction({
        opportunityId: props.opportunityId,
        status: status === props.status ? undefined : status,
        acquisitionPath: path,
        acquisitionDifficulty: difficulty,
        nextAction: nextAction.trim() === "" ? null : nextAction,
        notes: notes.trim() === "" ? undefined : notes,
      });
      if (result.ok) {
        toast.success(`${props.domain} updated.`);
        setOpen(false);
      } else {
        toast.error(result.error.message);
      }
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          Manage
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{props.domain}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="opp-status">Status</Label>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger id="opp-status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {OPPORTUNITY_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s.replace(/_/g, " ")}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="opp-difficulty">Difficulty</Label>
              <Select value={difficulty} onValueChange={setDifficulty}>
                <SelectTrigger id="opp-difficulty">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["easy", "moderate", "hard", "unknown"].map((d) => (
                    <SelectItem key={d} value={d}>
                      {d}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="opp-path">Acquisition path</Label>
            <Select value={path} onValueChange={setPath}>
              <SelectTrigger id="opp-path">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACQUISITION_PATHS.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="opp-next">Next action</Label>
            <Input
              id="opp-next"
              value={nextAction}
              onChange={(e) => setNextAction(e.target.value)}
              placeholder="Pitch the Q3 market data story to their editor."
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="opp-notes">Notes</Label>
            <Textarea
              id="opp-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Eligibility, contact research, constraints."
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
