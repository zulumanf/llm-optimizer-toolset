"use client";

/**
 * Source upload (D3, docs/pilot-launch-plan.md). The extraction pipeline —
 * PDF, XLSX, HTML, CSV, text — existed with no product path to feed it:
 * operators could not hand the platform a document. Uploads ingest
 * content-addressed (a duplicate is recognised, not re-stored) and queue
 * claim extraction automatically.
 */
import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { uploadSource } from "@/app/knowledge/actions";

const PRIVACY_OPTIONS = [
  { value: "public", label: "Public — usable in public content" },
  { value: "client_only", label: "Client-only — internal + client surfaces" },
  { value: "internal", label: "Internal — never client-facing" },
  { value: "restricted", label: "Restricted — humans only, never agents" },
];

export function UploadSource({ projectId }: { projectId: string }) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [privacy, setPrivacy] = useState("client_only");
  const [pending, startTransition] = useTransition();

  const submit = () =>
    startTransition(async () => {
      const file = fileRef.current?.files?.[0];
      if (!file) {
        toast.error("Choose a file first.");
        return;
      }
      const formData = new FormData();
      formData.set("projectId", projectId);
      formData.set("privacy", privacy);
      formData.set("file", file);
      const result = await uploadSource(formData);
      if (result.ok) {
        toast.success(
          result.data.duplicate
            ? "Already held — identical bytes were ingested before."
            : "Stored. Claim extraction is queued; proposed claims appear under Knowledge."
        );
        if (fileRef.current) fileRef.current.value = "";
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });

  return (
    <div className="mb-4 flex flex-wrap items-end gap-3 rounded-lg border p-3">
      <div className="min-w-56">
        <Label htmlFor="source-file" className="text-xs">
          Add a source (PDF, XLSX, CSV, HTML, text)
        </Label>
        <input
          id="source-file"
          ref={fileRef}
          type="file"
          className="mt-1 block w-full text-sm file:mr-3 file:rounded-md file:border file:bg-secondary file:px-3 file:py-1.5 file:text-xs"
        />
      </div>
      <div>
        <Label className="text-xs">Privacy</Label>
        <Select value={privacy} onValueChange={setPrivacy}>
          <SelectTrigger className="mt-1 h-9 w-64 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PRIVACY_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value} className="text-xs">
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button size="sm" onClick={submit} disabled={pending}>
        {pending ? "Uploading…" : "Upload & extract"}
      </Button>
    </div>
  );
}
