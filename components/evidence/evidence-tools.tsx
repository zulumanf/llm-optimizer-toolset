"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dices, PackageOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createAuditSample, generateEvidenceExport } from "@/app/evidence/actions";

export function EvidenceTools({ runId }: { runId: string; projectId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [exportInfo, setExportInfo] = useState<{ exportId: string; sha256: string } | null>(null);

  return (
    <div className="flex shrink-0 flex-col items-end gap-2">
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await createAuditSample({ runId, size: 5 });
              if (result.ok) {
                toast.success(
                  `Audit sample of ${result.data.selected} drawn (seed ${result.data.seed} — reproducible).`
                );
                router.refresh();
              } else {
                toast.error(result.error.message);
              }
            })
          }
        >
          <Dices className="size-4" /> Audit sample
        </Button>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              const result = await generateEvidenceExport({ runId });
              if (result.ok) {
                setExportInfo({
                  exportId: result.data.exportId,
                  sha256: result.data.sha256,
                });
                toast.success("Evidence package built and hash-recorded.");
              } else {
                toast.error(result.error.message);
              }
            })
          }
        >
          <PackageOpen className="size-4" />
          {pending ? "Working…" : "Export package"}
        </Button>
      </div>
      {exportInfo && (
        <p className="max-w-xs break-all text-right text-xs text-muted-foreground">
          <a
            href={`/api/evidence/${exportInfo.exportId}`}
            className="underline"
            download
          >
            download .tar.gz
          </a>{" "}
          · sha256 {exportInfo.sha256.slice(0, 16)}…
        </p>
      )}
    </div>
  );
}
