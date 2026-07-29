"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dices, PackageOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createAuditSample } from "@/app/evidence/actions";
import { BackgroundAction } from "@/components/jobs/background-action";

export function EvidenceTools({
  runId,
  latestExport,
}: {
  runId: string;
  projectId: string;
  /** Most recent completed package — served from the DB so the link
   * survives a refresh (the export now runs in the worker). */
  latestExport: { exportId: string; sha256: string } | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

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
        <BackgroundAction
          type="build_evidence_export"
          runId={runId}
          label="Export package"
          workingLabel="Packaging…"
          icon={<PackageOpen className="size-4" />}
        />
      </div>
      {latestExport && (
        <p className="max-w-xs break-all text-right text-xs text-muted-foreground">
          <a
            href={`/api/evidence/${latestExport.exportId}`}
            className="underline"
            download
          >
            download latest .tar.gz
          </a>{" "}
          · sha256 {latestExport.sha256.slice(0, 16)}…
        </p>
      )}
    </div>
  );
}
