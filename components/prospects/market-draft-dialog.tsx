"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Globe, MapPinned } from "lucide-react";
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
import {
  draftMarketPack,
  installMarketPackDraft,
  rejectMarketPackDraft,
} from "@/app/prospects/actions";

interface DraftView {
  draftId: string;
  cityName: string;
  neighborhoods: string[];
  brokerages: string[];
  publications: string[];
}

/**
 * Spec 082: research a new city into a reviewable pack draft, then install
 * it and open the launch in one reviewed act. The draft is never a market
 * until the operator installs it.
 */
export function MarketDraftDialog() {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [draft, setDraft] = useState<DraftView | null>(null);

  const research = () => {
    startTransition(async () => {
      const result = await draftMarketPack({ cityName: city, state });
      if (!result.ok) {
        toast.error(result.error.message);
        return;
      }
      const data = result.data as {
        draftId: string;
        error: string | null;
        pack: {
          cityName: string;
          hierarchy: { children?: Array<{ children?: Array<{ name: string }> }> };
          brokerages: string[];
          publications: string[];
        } | null;
      };
      if (data.error || !data.pack) {
        toast.error(data.error ?? "Research failed.");
        return;
      }
      setDraft({
        draftId: data.draftId,
        cityName: data.pack.cityName,
        neighborhoods:
          data.pack.hierarchy.children?.[0]?.children?.map((n) => n.name) ?? [],
        brokerages: data.pack.brokerages,
        publications: data.pack.publications,
      });
    });
  };

  const install = () => {
    startTransition(async () => {
      if (!draft) return;
      const result = await installMarketPackDraft({ draftId: draft.draftId });
      if (result.ok) {
        toast.success(`${draft.cityName} installed — launch opened.`);
        setOpen(false);
        setDraft(null);
        setCity("");
        setState("");
        window.location.reload();
      } else {
        toast.error(result.error.message);
      }
    });
  };

  const reject = () => {
    startTransition(async () => {
      if (!draft) return;
      const result = await rejectMarketPackDraft({ draftId: draft.draftId });
      if (result.ok) {
        toast.success("Draft rejected.");
        setDraft(null);
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline">
          <MapPinned className="size-4" aria-hidden />
          Draft new market
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Draft a new market</DialogTitle>
        </DialogHeader>
        {!draft ? (
          <div className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              One research call maps the city — neighborhoods, brokerages,
              publications — into a reviewable pack. Nothing installs until
              you approve it.
            </p>
            <div className="grid gap-1.5">
              <Label htmlFor="draft-city">City</Label>
              <Input
                id="draft-city"
                value={city}
                onChange={(event) => setCity(event.target.value)}
                placeholder="Hoboken"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="draft-state">State</Label>
              <Input
                id="draft-state"
                value={state}
                onChange={(event) => setState(event.target.value)}
                placeholder="New Jersey"
              />
            </div>
          </div>
        ) : (
          <div className="grid max-h-80 gap-2 overflow-y-auto text-sm">
            <p className="font-medium">{draft.cityName}</p>
            <p>
              <span className="text-muted-foreground">Neighborhoods ({draft.neighborhoods.length}):</span>{" "}
              {draft.neighborhoods.join(", ")}
            </p>
            <p>
              <span className="text-muted-foreground">Brokerages:</span>{" "}
              {draft.brokerages.join(", ") || "none found"}
            </p>
            <p>
              <span className="text-muted-foreground">Publications:</span>{" "}
              {draft.publications.join(", ") || "none found"}
            </p>
            <p className="flex items-center gap-1 text-xs text-muted-foreground">
              <Globe className="size-3" aria-hidden />
              Review the names — installing creates the market tree and opens
              the launch.
            </p>
          </div>
        )}
        <DialogFooter>
          {!draft ? (
            <Button onClick={research} disabled={pending || city.trim().length < 2 || state.trim().length < 2}>
              {pending ? "Researching…" : "Research city"}
            </Button>
          ) : (
            <>
              <Button variant="ghost" onClick={reject} disabled={pending}>
                Reject
              </Button>
              <Button onClick={install} disabled={pending}>
                {pending ? "Installing…" : "Install & open launch"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
