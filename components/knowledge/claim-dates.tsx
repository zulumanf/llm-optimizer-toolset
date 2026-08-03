"use client";

/**
 * Effective / review dates on a claim (D2, docs/pilot-launch-plan.md).
 *
 * These two columns had no production writer, which silently disabled every
 * detector keyed on them: date-window contradiction checks, the
 * expired-claim maintenance sweep, and the automation freshness gates all
 * reported "fresh" forever. A review date is the operator's promise to
 * re-verify; setting one is what makes claim expiry real.
 */
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setClaimDates } from "@/app/knowledge/actions";

export function ClaimDates({
  claimId,
  effectiveDate,
  reviewDate,
}: {
  claimId: string;
  effectiveDate: string | null;
  reviewDate: string | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [effective, setEffective] = useState(effectiveDate ?? "");
  const [review, setReview] = useState(reviewDate ?? "");
  const [pending, startTransition] = useTransition();

  const save = () =>
    startTransition(async () => {
      const result = await setClaimDates({
        claimId,
        effectiveDate: effective === "" ? null : effective,
        reviewDate: review === "" ? null : review,
      });
      if (result.ok) {
        toast.success("Dates recorded — freshness checks now apply.");
        setOpen(false);
        router.refresh();
      } else {
        toast.error(result.error.message);
      }
    });

  if (!open) {
    const summary = [
      effectiveDate ? `effective ${effectiveDate}` : null,
      reviewDate ? `review by ${reviewDate}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-muted-foreground underline-offset-2 hover:underline"
      >
        {summary || "no effective/review dates — expiry checks are blind to this claim"}
      </button>
    );
  }

  return (
    <div className="mt-2 flex flex-wrap items-end gap-2 rounded-md border p-2">
      <div>
        <Label htmlFor={`eff-${claimId}`} className="text-xs">
          Effective date
        </Label>
        <Input
          id={`eff-${claimId}`}
          type="date"
          value={effective}
          onChange={(event) => setEffective(event.target.value)}
          className="h-8 text-xs"
        />
      </div>
      <div>
        <Label htmlFor={`rev-${claimId}`} className="text-xs">
          Review by
        </Label>
        <Input
          id={`rev-${claimId}`}
          type="date"
          value={review}
          onChange={(event) => setReview(event.target.value)}
          className="h-8 text-xs"
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
