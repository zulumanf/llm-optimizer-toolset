"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Upload } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { importPrompts } from "@/app/prompts/actions";

interface Rejected {
  line: number;
  text: string;
  reason: string;
}

export function ImportPromptsDialog({ setId }: { setId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState("");
  const [rejected, setRejected] = useState<Rejected[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () =>
    startTransition(async () => {
      setError(null);
      setRejected([]);
      const result = await importPrompts({ setId, content });
      if (result.ok) {
        const { added, skippedDuplicates, rejected: rej } = result.data as {
          added: number;
          skippedDuplicates: number;
          rejected: Rejected[];
        };
        toast.success(
          `Imported ${added} prompt${added === 1 ? "" : "s"} · ${skippedDuplicates} duplicate${skippedDuplicates === 1 ? "" : "s"} skipped · ${rej.length} rejected.`
        );
        setRejected(rej);
        if (rej.length === 0) {
          setOpen(false);
          setContent("");
        }
        router.refresh();
      } else {
        setError(result.error.message);
      }
    });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        setError(null);
        setRejected([]);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Upload className="size-4" /> Import
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Import prompts</DialogTitle>
          <DialogDescription>
            Paste one prompt per line, or CSV with a header
            (text,category,language,tier). Rows without a category get a
            rule-based suggestion; rows no rule matches are rejected, never
            guessed. Duplicates are skipped.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="import-content">Prompts</Label>
          <Textarea
            id="import-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={10}
            placeholder={"What's the best CRM for solo agents?\nHubSpot vs Salesforce for small teams"}
          />
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {rejected.length > 0 && (
          <div className="max-h-40 overflow-y-auto rounded-md border p-2 text-sm">
            <p className="mb-1 font-medium">Rejected rows</p>
            {rejected.map((r) => (
              <p key={`${r.line}-${r.reason}`} className="text-muted-foreground">
                line {r.line}: {r.reason} — “{r.text.slice(0, 60)}”
              </p>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
            Close
          </Button>
          <Button onClick={submit} disabled={pending || content.trim().length === 0}>
            {pending ? "Importing…" : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
