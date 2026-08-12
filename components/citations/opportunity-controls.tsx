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
  linkPlacementAction,
  requestPresenceCheckAction,
  updateOpportunityAction,
} from "@/app/projects/[id]/citations/actions";
import {
  ACQUISITION_DIFFICULTIES,
  ACQUISITION_PATHS,
  OPPORTUNITY_STATUSES,
} from "@/lib/citations/constants";

/** `measuring` is entered by linking a placement, never picked by hand —
 * the server refuses it, so the dialog doesn't offer it. */
const SELECTABLE_STATUSES = OPPORTUNITY_STATUSES.filter((s) => s !== "measuring");

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
                  {SELECTABLE_STATUSES.map((s) => (
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
                  {ACQUISITION_DIFFICULTIES.map((d) => (
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

export interface VersionOption {
  id: string;
  label: string;
}

/**
 * A won placement becomes an intervention (spec 060): baselines, live URL
 * verification, and retests come from the experiment machinery — this dialog
 * is the only door into `measuring`.
 */
export function LinkPlacementDialog({
  opportunityId,
  domain,
  versions,
}: {
  opportunityId: string;
  domain: string;
  versions: VersionOption[];
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [urls, setUrls] = useState("");
  const [shippedAt, setShippedAt] = useState(new Date().toISOString().slice(0, 10));
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const [cost, setCost] = useState("");

  const submit = () =>
    startTransition(async () => {
      const result = await linkPlacementAction({
        opportunityId,
        urls: urls
          .split(/\s+/)
          .map((u) => u.trim())
          .filter(Boolean),
        promptSetVersionId: versionId,
        shippedAt,
        costUsd: cost.trim() === "" ? undefined : Number(cost),
      });
      if (result.ok) {
        toast.success(`Placement linked — ${domain} is now measuring.`);
        setOpen(false);
      } else {
        toast.error(result.error.message);
      }
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">Link placement</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Link placement — {domain}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="placement-urls">Live placement URL(s)</Label>
            <Textarea
              id="placement-urls"
              value={urls}
              onChange={(e) => setUrls(e.target.value)}
              placeholder={`https://${domain}/your-feature (one per line)`}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label htmlFor="placement-shipped">Went live on</Label>
              <Input
                id="placement-shipped"
                type="date"
                value={shippedAt}
                onChange={(e) => setShippedAt(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="placement-cost">Cost USD (optional)</Label>
              <Input
                id="placement-cost"
                inputMode="decimal"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="0"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="placement-version">Measure against prompt version</Label>
            <Select value={versionId} onValueChange={setVersionId}>
              <SelectTrigger id="placement-version">
                <SelectValue placeholder="Pick the instrument" />
              </SelectTrigger>
              <SelectContent>
                {versions.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            Creates an intervention: URLs get verified live, and the same
            prompt version re-runs at +2, +6, and +12 weeks. The outcome is
            whatever those verdicts show.
          </p>
        </div>
        <DialogFooter>
          <Button
            onClick={submit}
            disabled={pending || urls.trim() === "" || versionId === ""}
          >
            {pending ? "Linking…" : "Link & start measuring"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
