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
import { proposeClaim } from "@/app/knowledge/actions";

export function ProposeClaimDialog({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [key, setKey] = useState("");
  const [text, setText] = useState("");
  const [asOf, setAsOf] = useState(new Date().toISOString().slice(0, 10));
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = () =>
    startTransition(async () => {
      setError(null);
      const result = await proposeClaim({
        projectId,
        key,
        canonicalText: text,
        asOf,
        evidence: [{ url, note }],
      });
      if (result.ok) {
        toast.success("Claim proposed — approve it to make it agent-usable.");
        setOpen(false);
        setKey(""); setText(""); setUrl(""); setNote("");
        router.refresh();
      } else {
        setError(result.error.message);
      }
    });

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); setError(null); }}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> Propose claim
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Propose a claim</DialogTitle>
          <DialogDescription>
            One verifiable fact with canonical wording and at least one
            evidence source. Approval makes it agent-usable.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="cl-key">Key (snake_case)</Label>
              <Input
                id="cl-key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder="category_positioning"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cl-asof">As of</Label>
              <Input
                id="cl-asof"
                type="date"
                value={asOf}
                onChange={(e) => setAsOf(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cl-text">Canonical wording</Label>
            <Textarea
              id="cl-text"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Lumina is a link-in-bio tool built for real estate agents."
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cl-url">Evidence URL</Label>
            <Input
              id="cl-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cl-note">Why this supports the claim</Label>
            <Input
              id="cl-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !key || !text || !url || !note}
          >
            {pending ? "Proposing…" : "Propose"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
