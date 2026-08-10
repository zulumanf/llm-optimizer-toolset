"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { acknowledgeDrift } from "@/app/control-tower/actions";
import type { DriftSignalRow } from "@/lib/drift/detect";

const KIND_LABEL: Record<string, string> = {
  fleet_movement: "Fleet movement",
  provider_shape: "Answer format changed",
  sentinel_deviation: "Sentinel moved",
};

/** Open fleet-level drift signals (spec 053). While one is open, every
 * client's deltas are suspect — acknowledge records who decided what. */
export function DriftSignals({ signals }: { signals: DriftSignalRow[] }) {
  const [pending, startTransition] = useTransition();

  if (signals.length === 0) return null;

  const acknowledge = (signalId: string) =>
    startTransition(async () => {
      const result = await acknowledgeDrift({ signalId });
      if (result.ok) toast.success("Signal acknowledged.");
      else toast.error(result.error.message);
    });

  return (
    <section className="mb-8">
      <h2 className="mb-2 text-lg font-medium">
        Instrument drift{" "}
        <span className="text-sm font-normal text-muted-foreground">
          ({signals.length} open)
        </span>
      </h2>
      <ul className="space-y-2">
        {signals.map((s) => (
          <li
            key={s.id}
            className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="mb-1 flex flex-wrap items-center gap-2">
                <Badge variant="destructive">{KIND_LABEL[s.kind] ?? s.kind}</Badge>
                <span className="text-xs text-muted-foreground">
                  {s.provider}
                  {s.metric ? ` · ${s.metric.replace(/_/g, " ")}` : ""} ·{" "}
                  {new Date(s.detectedAt).toLocaleDateString()}
                </span>
              </p>
              <p>{s.summary}</p>
              {s.affected.length > 0 && (
                <p className="mt-1 text-xs text-muted-foreground">
                  Affected:{" "}
                  {s.affected
                    .map((a) => `${a.projectName} (${(a.delta * 100).toFixed(0)} pts)`)
                    .join(", ")}
                </p>
              )}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={() => acknowledge(s.id)}
            >
              Acknowledge
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
