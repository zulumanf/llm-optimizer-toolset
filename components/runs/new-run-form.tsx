"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { startRun, estimateRun } from "@/app/runs/actions";
import type { ModelInfo, ProviderId } from "@/lib/ai/types";

export interface VersionOption {
  id: string;
  setName: string;
  version: number;
  promptCount: number;
}

interface ProviderRow {
  enabled: boolean;
  provider: ProviderId;
  model: string;
  repetitions: number;
}

interface Estimate {
  cellCount: number;
  estimatedMicroUsd: number;
  unverifiedPricing: string[];
}

interface Props {
  projectId: string;
  versions: VersionOption[];
  models: ModelInfo[];
  /** Providers with configured API keys (mock when none) — checked by default. */
  defaultEnabled: ProviderId[];
}

export function NewRunForm({ projectId, versions, models, defaultEnabled }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [versionId, setVersionId] = useState(versions[0]?.id ?? "");
  const [label, setLabel] = useState("");
  const [budget, setBudget] = useState("15");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [error, setError] = useState<string | null>(null);

  const providerIds = [...new Set(models.map((m) => m.provider))];
  const [rows, setRows] = useState<ProviderRow[]>(
    providerIds.map((p) => ({
      enabled: defaultEnabled.includes(p),
      provider: p,
      model: models.find((m) => m.provider === p)?.id ?? "",
      repetitions: 5,
    }))
  );

  const selectedProviders = rows
    .filter((r) => r.enabled)
    .map(({ provider, model, repetitions }) => ({ provider, model, repetitions }));

  const updateRow = (provider: ProviderId, patch: Partial<ProviderRow>) => {
    setRows((prev) =>
      prev.map((r) => (r.provider === provider ? { ...r, ...patch } : r))
    );
    setEstimate(null);
  };

  const doEstimate = () => {
    setError(null);
    startTransition(async () => {
      const result = await estimateRun({
        promptSetVersionId: versionId,
        providers: selectedProviders,
      });
      if (result.ok) setEstimate(result.data);
      else setError(result.error.message);
    });
  };

  const doStart = () => {
    setError(null);
    startTransition(async () => {
      const result = await startRun({
        projectId,
        promptSetVersionId: versionId,
        providers: selectedProviders,
        budgetUsd: Number(budget),
        label,
      });
      if (result.ok) {
        toast.success("Run started — the worker will pick it up.");
        router.push(`/projects/${projectId}/runs/${result.data.id}`);
      } else {
        setError(result.error.message);
      }
    });
  };

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="space-y-1.5">
          <Label>Prompt set version</Label>
          <Select value={versionId} onValueChange={(v) => { setVersionId(v); setEstimate(null); }}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {versions.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.setName} — v{v.version} ({v.promptCount} prompts)
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label>Providers</Label>
          {rows.map((row) => (
            <div key={row.provider} className="flex items-center gap-3 rounded-md border p-3">
              <input
                type="checkbox"
                id={`prov-${row.provider}`}
                checked={row.enabled}
                onChange={(e) => updateRow(row.provider, { enabled: e.target.checked })}
                className="size-4"
              />
              <Label htmlFor={`prov-${row.provider}`} className="w-24 capitalize">
                {row.provider}
              </Label>
              <Select
                value={row.model}
                onValueChange={(m) => updateRow(row.provider, { model: m })}
              >
                <SelectTrigger className="flex-1" disabled={!row.enabled}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {models
                    .filter((m) => m.provider === row.provider)
                    .map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.label}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1.5">
                <Label htmlFor={`reps-${row.provider}`} className="text-xs text-muted-foreground">
                  reps
                </Label>
                <Input
                  id={`reps-${row.provider}`}
                  type="number"
                  min={1}
                  max={10}
                  value={row.repetitions}
                  disabled={!row.enabled}
                  onChange={(e) =>
                    updateRow(row.provider, { repetitions: Number(e.target.value) })
                  }
                  className="w-16"
                />
              </div>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label htmlFor="run-budget">Budget cap (USD)</Label>
            <Input
              id="run-budget"
              type="number"
              min={0.5}
              max={100}
              step={0.5}
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="run-label">Label</Label>
            <Input
              id="run-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder={`Baseline ${new Date().toISOString().slice(0, 10)}`}
            />
          </div>
        </div>

        {estimate && (
          <div className="rounded-md border bg-muted/40 px-4 py-3 text-sm">
            <p>
              {estimate.cellCount} calls · estimated ≈ $
              {(estimate.estimatedMicroUsd / 1_000_000).toFixed(2)}
            </p>
            {estimate.unverifiedPricing.length > 0 && (
              <p className="mt-1 text-warning">
                Pricing not verified for: {estimate.unverifiedPricing.join(", ")} —
                estimate may be off (lib/ai/pricing.ts).
              </p>
            )}
          </div>
        )}
        {error && <p className="text-sm text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={doEstimate}
            disabled={pending || selectedProviders.length === 0 || !versionId}
          >
            Estimate
          </Button>
          <Button
            onClick={doStart}
            disabled={
              pending ||
              selectedProviders.length === 0 ||
              !versionId ||
              label.trim().length === 0
            }
          >
            {pending ? "Working…" : "Start run"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
