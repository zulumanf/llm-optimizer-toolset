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
import { updateBaselineSettings } from "@/app/projects/actions";
import type { ModelInfo, ProviderId } from "@/lib/ai/types";
import type { ProviderConfig } from "@/lib/runs/cells";

const OFF = "__off__";

interface Props {
  projectId: string;
  sets: { id: string; name: string; latestVersion: number | null }[];
  models: ModelInfo[];
  current: {
    baselinePromptSetId: string | null;
    providers: ProviderConfig[] | null;
    budgetUsd: number | null;
  };
}

export function BaselineSettingsForm({ projectId, sets, models, current }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [setId, setSetId] = useState(current.baselinePromptSetId ?? OFF);
  const [budget, setBudget] = useState(String(current.budgetUsd ?? 10));
  const [error, setError] = useState<string | null>(null);

  const providerIds = [...new Set(models.map((m) => m.provider))];
  const [rows, setRows] = useState(
    providerIds.map((provider) => {
      const existing = current.providers?.find((p) => p.provider === provider);
      return {
        provider,
        enabled: Boolean(existing),
        model: existing?.model ?? models.find((m) => m.provider === provider)?.id ?? "",
        repetitions: existing?.repetitions ?? 5,
      };
    })
  );
  const enabled = setId !== OFF;

  const save = () =>
    startTransition(async () => {
      setError(null);
      const providers = rows
        .filter((r) => r.enabled)
        .map(({ provider, model, repetitions }) => ({
          provider: provider as ProviderId,
          model,
          repetitions,
        }));
      const result = await updateBaselineSettings({
        projectId,
        baselinePromptSetId: enabled ? setId : null,
        ...(enabled ? { providers, budgetUsd: Number(budget) } : {}),
      });
      if (result.ok) {
        toast.success(enabled ? "Weekly baseline configured." : "Weekly baseline disabled.");
        router.refresh();
      } else {
        setError(result.error.message);
      }
    });

  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <div className="space-y-1.5">
          <Label>Baseline prompt set</Label>
          <Select value={setId} onValueChange={setSetId}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={OFF}>Disabled — no weekly baseline</SelectItem>
              {sets.map((s) => (
                <SelectItem key={s.id} value={s.id} disabled={s.latestVersion === null}>
                  {s.name}
                  {s.latestVersion === null
                    ? " (never frozen — freeze it first)"
                    : ` (runs latest frozen, currently v${s.latestVersion})`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {enabled && (
          <>
            <div className="space-y-2">
              <Label>Providers</Label>
              {rows.map((row, index) => (
                <div key={row.provider} className="flex items-center gap-3 rounded-md border p-3">
                  <input
                    type="checkbox"
                    id={`bl-${row.provider}`}
                    checked={row.enabled}
                    onChange={(e) =>
                      setRows((prev) =>
                        prev.map((r, i) =>
                          i === index ? { ...r, enabled: e.target.checked } : r
                        )
                      )
                    }
                    className="size-4"
                  />
                  <Label htmlFor={`bl-${row.provider}`} className="w-24 capitalize">
                    {row.provider}
                  </Label>
                  <Select
                    value={row.model}
                    onValueChange={(m) =>
                      setRows((prev) =>
                        prev.map((r, i) => (i === index ? { ...r, model: m } : r))
                      )
                    }
                  >
                    <SelectTrigger className="flex-1" disabled={!row.enabled}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {models
                        .filter((m) => m.provider === row.provider)
                        .map((m) => (
                          <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                  <div className="flex items-center gap-1.5">
                    <Label className="text-xs text-muted-foreground">reps</Label>
                    <Input
                      type="number"
                      min={1}
                      max={10}
                      value={row.repetitions}
                      disabled={!row.enabled}
                      onChange={(e) =>
                        setRows((prev) =>
                          prev.map((r, i) =>
                            i === index
                              ? { ...r, repetitions: Number(e.target.value) }
                              : r
                          )
                        )
                      }
                      className="w-16"
                    />
                  </div>
                </div>
              ))}
            </div>
            <div className="w-48 space-y-1.5">
              <Label htmlFor="bl-budget">Budget cap per run (USD)</Label>
              <Input
                id="bl-budget"
                type="number"
                min={0.5}
                max={100}
                step={0.5}
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
              />
            </div>
          </>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end">
          <Button
            onClick={save}
            disabled={pending || (enabled && rows.every((r) => !r.enabled))}
          >
            {pending ? "Saving…" : "Save settings"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
