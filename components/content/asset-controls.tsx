"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { FileCheck, FileEdit, Lock, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  generateDraft,
  verifyDraft,
  approveAsset,
  markPublished,
} from "@/app/content/actions";

interface Props {
  assetId: string;
  status: string;
  versions: { id: string; label: string }[];
}

export function AssetControls({ assetId, status, versions }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [publishOpen, setPublishOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const [publishedOn, setPublishedOn] = useState(new Date().toISOString().slice(0, 10));

  const act = (fn: () => Promise<{ ok: boolean; error?: { message: string } }>, done: string) =>
    startTransition(async () => {
      const result = await fn();
      if (result.ok) {
        toast.success(done);
        setPublishOpen(false);
        router.refresh();
      } else {
        toast.error(result.error?.message ?? "Action failed.");
      }
    });

  return (
    <div className="flex shrink-0 gap-2">
      {(status === "briefed" || status === "drafted") && (
        <Button
          size="sm"
          variant={status === "briefed" ? "default" : "outline"}
          disabled={pending}
          onClick={() =>
            act(
              () => generateDraft({ assetId }),
              "Draft generated — review it, then run verification."
            )
          }
        >
          <FileEdit className="size-4" />
          {pending ? "Working…" : status === "briefed" ? "Generate draft" : "Redraft"}
        </Button>
      )}
      {status === "drafted" && (
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            act(
              () => verifyDraft({ assetId }),
              "Verification complete."
            )
          }
        >
          <FileCheck className="size-4" /> {pending ? "Verifying…" : "Verify"}
        </Button>
      )}
      {status === "verified" && (
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            act(() => approveAsset({ assetId }), "Approved — ready to publish.")
          }
        >
          <Lock className="size-4" /> Approve
        </Button>
      )}
      {status === "approved" && (
        <Button size="sm" disabled={pending} onClick={() => setPublishOpen(true)}>
          <Send className="size-4" /> Record publish…
        </Button>
      )}

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record the publish</DialogTitle>
            <DialogDescription>
              You publish the page yourself (copy the draft — citation tokens
              strip automatically). Recording it here creates the intervention
              that measures its effect at +2/+6/+12 weeks.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="pub-url">Published URL</Label>
              <Input
                id="pub-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://parva.io/for-real-estate-agents"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="pub-date">Published on</Label>
                <Input
                  id="pub-date"
                  type="date"
                  value={publishedOn}
                  onChange={(e) => setPublishedOn(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Measure with</Label>
                <Select value={versionId} onValueChange={setVersionId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Frozen set…" />
                  </SelectTrigger>
                  <SelectContent>
                    {versions.map((v) => (
                      <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPublishOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              disabled={pending || !url || !versionId}
              onClick={() =>
                act(
                  () =>
                    markPublished({
                      assetId,
                      publishedUrl: url,
                      promptSetVersionId: versionId,
                      publishedOn,
                    }),
                  "Published recorded — measuring intervention scheduled."
                )
              }
            >
              {pending ? "Recording…" : "Record & measure"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
