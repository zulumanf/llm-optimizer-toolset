"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Check, Globe, Search, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  approveEnrichmentProposal,
  enrichProspect,
  rejectEnrichmentProposal,
} from "@/app/prospects/actions";
import type { EnrichmentProposalRow } from "@/lib/prospects/enrichment";

/**
 * Spec 079: run Perplexity research and decide on what it found. Every
 * proposal shows its citations; approval is the only path to a platform
 * fact. Found ≠ true — the operator's click is the verification.
 */
export function EnrichmentPanel({
  prospectId,
  initial,
  keyConfigured,
}: {
  prospectId: string;
  initial: EnrichmentProposalRow[];
  keyConfigured: boolean;
}) {
  const [proposals, setProposals] = useState(initial);
  const [pending, startTransition] = useTransition();

  const research = () => {
    startTransition(async () => {
      const result = await enrichProspect({ prospectId, force: true });
      if (result.ok) {
        const data = result.data as { outcome: string; proposals: number; detail?: string };
        if (data.outcome === "enriched") {
          toast.success(
            data.proposals === 0
              ? "Research ran — nothing new found."
              : `${data.proposals} proposal(s) staged — review below.`
          );
          window.location.reload();
        } else if (data.outcome === "skipped_complete") {
          toast.success("Nothing missing — no credits spent.");
        } else {
          toast.error(data.detail ?? `Research ${data.outcome}.`);
        }
      } else {
        toast.error(result.error.message);
      }
    });
  };

  const decide = (proposalId: string, approve: boolean) => {
    startTransition(async () => {
      const result = approve
        ? await approveEnrichmentProposal({ proposalId })
        : await rejectEnrichmentProposal({ proposalId });
      if (result.ok) {
        toast.success(approve ? "Added to the prospect." : "Rejected.");
        setProposals((rows) => rows.filter((r) => r.id !== proposalId));
      } else {
        toast.error(result.error.message);
      }
    });
  };

  return (
    <div className="rounded-md border p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">Research — find email &amp; production data</p>
        <Button
          size="sm"
          variant="outline"
          onClick={research}
          disabled={pending || !keyConfigured}
        >
          <Search className="size-4" aria-hidden />
          {pending ? "Researching…" : "Run research"}
        </Button>
      </div>
      {!keyConfigured ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          PERPLEXITY_API_KEY is not configured — set it in the environment to
          enable research.
        </p>
      ) : proposals.length === 0 ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Asks Perplexity ONE question covering only what&apos;s missing
          (email, volume, sides, rank). Findings stage here with citations —
          nothing becomes a fact without your approval.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {proposals.map((proposal) => (
            <li key={proposal.id} className="flex items-start gap-2">
              {proposal.status === "failed" ? (
                <p className="text-xs text-destructive">
                  Research failed: {proposal.error ?? "unknown"} — re-run when ready.
                </p>
              ) : (
                <>
                  <Badge variant="secondary">
                    {proposal.kind === "contact_email"
                      ? "email"
                      : proposal.kind === "buying_signal"
                        ? `timing · ${String(proposal.payload.kind ?? "signal").replaceAll("_", " ")}`
                        : String(proposal.payload.kind ?? "signal").replaceAll("_", " ")}
                  </Badge>
                  <span className="min-w-0 flex-1">
                    {proposal.kind === "contact_email"
                      ? `${proposal.payload.email} (${proposal.payload.name})`
                      : String(proposal.payload.label)}
                    {proposal.confidence !== null && (
                      <span className="text-muted-foreground">
                        {" "}· {Math.round(proposal.confidence * 100)}%
                      </span>
                    )}
                    {proposal.citations.slice(0, 2).map((url) => (
                      <a
                        key={url}
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                      >
                        <Globe className="size-3" aria-hidden />
                        {new URL(url).hostname.replace(/^www\./, "")}
                      </a>
                    ))}
                  </span>
                  <span className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => decide(proposal.id, true)}
                      disabled={pending}
                    >
                      <Check className="size-4" aria-hidden /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => decide(proposal.id, false)}
                      disabled={pending}
                    >
                      <X className="size-4" aria-hidden />
                    </Button>
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
