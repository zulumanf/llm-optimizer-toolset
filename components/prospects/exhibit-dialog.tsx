"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Link2, Plus } from "lucide-react";
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
import { addExhibit, archiveExhibit } from "@/app/prospects/actions";

export function ExhibitDialog({ prospectId }: { prospectId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [url, setUrl] = useState("");
  const [question, setQuestion] = useState("");
  const [capturedOn, setCapturedOn] = useState(new Date().toISOString().slice(0, 10));

  const submit = () => {
    startTransition(async () => {
      const result = await addExhibit({ prospectId, url, question, capturedOn });
      if (result.ok) {
        toast.success("Live chat attached — it will appear on the next published audit.");
        setOpen(false);
        setUrl("");
        setQuestion("");
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="size-4" /> Attach live chat
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach a live example chat</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="exhibit-url">Share link</Label>
            <Input
              id="exhibit-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://chatgpt.com/share/…"
            />
            <p className="text-xs text-muted-foreground">
              ChatGPT share links or Perplexity threads only — the exhibit must live on
              the assistant&apos;s own domain. Ask in a fresh chat with memory off, so
              nobody can claim the answer was personalized.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exhibit-question">The question you asked</Label>
            <Input
              id="exhibit-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Who are the best real estate agents in Jersey City?"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="exhibit-date">Asked on</Label>
            <Input
              id="exhibit-date"
              type="date"
              value={capturedOn}
              onChange={(e) => setCapturedOn(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={submit}
            disabled={pending || !url.trim() || !question.trim() || !capturedOn}
          >
            <Link2 className="size-4" /> {pending ? "Attaching…" : "Attach"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function ArchiveExhibitButton({ exhibitId }: { exhibitId: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await archiveExhibit({ exhibitId });
          if (result.ok) toast.success("Exhibit archived.");
          else toast.error(result.error.message);
        })
      }
    >
      Archive
    </Button>
  );
}
