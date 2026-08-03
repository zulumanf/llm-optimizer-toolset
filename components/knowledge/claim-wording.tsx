"use client";

/**
 * Allowed / prohibited wording on a claim (D4, docs/pilot-launch-plan.md).
 *
 * These lists were read into every packet ("use wording… / never say…") but
 * only the demo seed ever wrote them, and nothing enforced them. Now the
 * operator sets them here, the drafting prompt carries them, and the
 * deterministic content gate FAILS any draft that uses a prohibited phrase —
 * a rule, not a request.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setClaimWording } from "@/app/knowledge/actions";

function parseList(value: string): string[] {
  return value
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function ClaimWording({
  claimId,
  allowedWording,
  prohibitedWording,
}: {
  claimId: string;
  allowedWording: string[];
  prohibitedWording: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [allowed, setAllowed] = useState(allowedWording.join("; "));
  const [prohibited, setProhibited] = useState(prohibitedWording.join("; "));
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      const result = await setClaimWording({
        claimId,
        allowedWording: parseList(allowed),
        prohibitedWording: parseList(prohibited),
      });
      if (result.ok) {
        toast.success("Wording rules recorded — the content gate enforces them.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });

  if (!open) {
    const summary = [
      allowedWording.length > 0 ? `${allowedWording.length} allowed` : null,
      prohibitedWording.length > 0 ? `${prohibitedWording.length} prohibited` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
      >
        {summary ? `wording: ${summary}` : "no wording rules"}
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border p-2">
      <div>
        <Label htmlFor={`allowed-${claimId}`} className="text-xs">
          Allowed wording (semicolon-separated)
        </Label>
        <Input
          id={`allowed-${claimId}`}
          value={allowed}
          onChange={(event) => setAllowed(event.target.value)}
          placeholder="phrases drafts should prefer"
          className="mt-1 h-8 text-xs"
        />
      </div>
      <div>
        <Label htmlFor={`prohibited-${claimId}`} className="text-xs">
          Prohibited wording (semicolon-separated — the gate fails drafts using these)
        </Label>
        <Input
          id={`prohibited-${claimId}`}
          value={prohibited}
          onChange={(event) => setProhibited(event.target.value)}
          placeholder="e.g. #1 brokerage; the only luxury specialist"
          className="mt-1 h-8 text-xs"
        />
      </div>
      <div className="flex gap-2">
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
