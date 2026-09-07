"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Lightbulb, Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  generatePromptSuggestions,
  approvePromptSuggestion,
  rejectPromptSuggestion,
} from "@/app/prompts/actions";
import { MARKET_PACKS } from "@/lib/markets/packs";

export interface SuggestionRow {
  id: string;
  text: string;
  category: string;
  tier: number | null;
  audience: string | null;
  priceTier: string | null;
  neighborhood: string | null;
  building: string | null;
  propertyType: string | null;
  origin: string;
  rationale: string;
}

export function SuggestionsPanel({
  setId,
  suggestions,
}: {
  setId: string;
  suggestions: SuggestionRow[];
}) {
  const [pending, startTransition] = useTransition();
  const [packKey, setPackKey] = useState<string>(MARKET_PACKS[0]?.key ?? "");

  const propose = () => {
    startTransition(async () => {
      const result = await generatePromptSuggestions({ setId, packKey });
      if (result.ok) {
        const r = result.data as {
          staged: number;
          skippedExisting: number;
          skippedByCap: number;
        };
        toast.success(
          r.staged > 0
            ? `Staged ${r.staged} suggestion(s) for review (${r.skippedExisting} already covered).`
            : `Nothing new to propose — ${r.skippedExisting} combination(s) already covered.`
        );
      } else {
        toast.error(result.error.message);
      }
    });
  };

  const decide = (suggestionId: string, approve: boolean) => {
    startTransition(async () => {
      const result = approve
        ? await approvePromptSuggestion({ suggestionId })
        : await rejectPromptSuggestion({ suggestionId });
      if (result.ok) {
        toast.success(approve ? "Added to the set." : "Rejected.");
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <section className="mt-8">
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-lg font-medium">Suggested prompts</h2>
        <div className="flex items-center gap-2">
          <Select value={packKey} onValueChange={setPackKey}>
            <SelectTrigger size="sm" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MARKET_PACKS.map((p) => (
                <SelectItem key={p.key} value={p.key}>
                  {p.cityName} (v{p.version})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            size="sm"
            onClick={propose}
            disabled={pending || !packKey}
          >
            <Lightbulb className="size-4" />
            {pending ? "Proposing…" : "Propose missing prompts"}
          </Button>
        </div>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        Buyer/seller questions the pack covers but this set doesn&apos;t monitor
        yet. Nothing measures until you approve it.
      </p>
      {suggestions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-sm text-muted-foreground">
            No pending suggestions. Propose from a market pack to check whether
            the decision space is fully covered.
          </p>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {suggestions.map((s) => (
            <li key={s.id} className="flex items-center gap-3 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="truncate font-mono text-sm">{s.text}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {s.rationale}
                </p>
              </div>
              <Badge variant="secondary">{s.category}</Badge>
              {s.neighborhood && <Badge variant="outline">{s.neighborhood}</Badge>}
              {s.propertyType && <Badge variant="outline">{s.propertyType}</Badge>}
              {s.priceTier && <Badge variant="outline">{s.priceTier}</Badge>}
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => decide(s.id, true)}
                  disabled={pending}
                  aria-label="Approve suggestion"
                >
                  <Check className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => decide(s.id, false)}
                  disabled={pending}
                  aria-label="Reject suggestion"
                >
                  <X className="size-4" />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
