"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { CheckCircle2, Circle, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { quickStartLaunch } from "@/app/prospects/actions";
import { MARKET_PACKS } from "@/lib/markets/packs";

export interface GuideState {
  hasLaunch: boolean;
  hasProspects: boolean;
  hasBenchmarking: boolean;
  hasScore: boolean;
  hasOutreach: boolean;
}

interface Step {
  key: string;
  title: string;
  how: string;
  done: boolean;
}

/**
 * The prospecting pipeline as a visible checklist (spec 032 UX): where you
 * are, what's next, and the action for the next step inline — so "where do
 * I start?" is answered by the page instead of the operator's memory.
 */
export function PipelineGuide({ state }: { state: GuideState }) {
  const [pending, startTransition] = useTransition();

  const steps: Step[] = [
    {
      key: "launch",
      title: "1 · Open a market launch",
      how: "One click below installs a city's geography (neighborhoods, aliases) and opens a launch on it. Or use New launch for a custom market.",
      done: state.hasLaunch,
    },
    {
      key: "prospects",
      title: "2 · Build the prospect universe",
      how: "Discover (provider candidates you approve), Import CSV (a leading-teams list), or Add prospect by hand — all three land in the launch with per-fact provenance.",
      done: state.hasProspects,
    },
    {
      key: "research",
      title: "3 · Research & benchmark",
      how: "Open a prospect → record authority signals with sources, add the decision-maker as a contact, then Create benchmark project and run city prompts (generate them from the market pack) to measure AI visibility.",
      done: state.hasBenchmarking,
    },
    {
      key: "score",
      title: "4 · Score & approve findings",
      how: "On the prospect: fill the assessment checklist, Compute score, generate findings from the benchmark and approve the strongest as primary.",
      done: state.hasScore,
    },
    {
      key: "outreach",
      title: "5 · Audit page & outreach",
      how: "Publish the evidence-backed audit page, draft the reply-first email to the contact, approve it — sending stays a human click, gated by the suppression list.",
      done: state.hasOutreach,
    },
  ];
  const nextIndex = steps.findIndex((s) => !s.done);

  const quickStart = (packKey: string, cityName: string) => {
    startTransition(async () => {
      const result = await quickStartLaunch({ packKey });
      if (result.ok) {
        toast.success(`${cityName} is set up — launch created. Next: add prospects.`);
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <ol className="grid gap-2 lg:grid-cols-5">
      {steps.map((step, index) => {
        const isNext = index === nextIndex;
        return (
          <li
            key={step.key}
            className={`rounded-md border p-3 text-sm ${isNext ? "border-primary" : ""}`}
          >
            <div className="flex items-center gap-1.5">
              {step.done ? (
                <CheckCircle2 className="size-4 shrink-0 text-primary" />
              ) : (
                <Circle className="size-4 shrink-0 text-muted-foreground" />
              )}
              <span className="font-medium">{step.title}</span>
              {isNext && (
                <span className="ml-auto rounded bg-primary px-1.5 py-0.5 text-xs text-primary-foreground">
                  next
                </span>
              )}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{step.how}</p>
            {step.key === "launch" && !step.done && (
              <div className="mt-2 flex flex-wrap gap-1">
                {MARKET_PACKS.map((pack) => (
                  <Button
                    key={pack.key}
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => quickStart(pack.key, pack.cityName)}
                  >
                    <MapPin className="size-3.5" /> {pack.cityName}
                  </Button>
                ))}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
