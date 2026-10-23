"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  PRIMARY_FOCUS_OPTIONS,
  parseUsdInput,
  primaryFocusLabel,
  usd,
  type OnboardingContacts,
  type OnboardingPriorities,
  type PrimaryFocus,
} from "@/lib/engagements/client-onboarding-rules";
import { submitDetailCorrection } from "@/app/portal/[projectId]/actions";
import { ONBOARDING_COPY } from "@/lib/portal/client-copy";

/**
 * Your details after onboarding (spec 155 R5). Shows the current confirmed
 * version; the approver can submit a correction, which is recorded as a new
 * version — the original confirmation is never edited.
 */
export function DetailsCorrection({
  projectId,
  detailsVersion,
  priorities,
  contacts,
  canCorrect,
}: {
  projectId: string;
  detailsVersion: number;
  priorities: OnboardingPriorities;
  contacts: OnboardingContacts;
  canCorrect: boolean;
}) {
  const id = useId();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [d, setD] = useState({
    focus: priorities.primaryFocus as PrimaryFocus,
    min: priorities.minPropertyValueUsd ? priorities.minPropertyValueUsd.toLocaleString("en-US") : "",
    opportunity: priorities.additionalOpportunity,
    market: priorities.market,
    name: contacts.primaryName,
    email: contacts.primaryEmail,
    approverIsPrimary: contacts.approverIsPrimary,
    approverName: contacts.approverName,
    approverEmail: contacts.approverEmail,
  });

  const save = () => {
    setError(null);
    const min = d.min.trim() === "" ? null : parseUsdInput(d.min);
    if (d.min.trim() !== "" && min === null) return setError("Enter the minimum as an amount, like 300,000.");
    if (d.market.trim().length < 2) return setError("Tell us the area you serve.");
    if (!d.name.trim()) return setError("Tell us who we should work with.");
    if (!/^\S+@\S+\.\S+$/.test(d.email.trim())) return setError("Enter a valid email address.");
    if (!d.approverIsPrimary && !d.approverName.trim()) return setError("Tell us who approves public changes.");
    start(async () => {
      try {
        const r = await submitDetailCorrection(
          projectId,
          { primaryFocus: d.focus, minPropertyValueUsd: min, additionalOpportunity: d.opportunity.trim(), market: d.market.trim() },
          { primaryName: d.name.trim(), primaryEmail: d.email.trim(), approverIsPrimary: d.approverIsPrimary, approverName: d.approverName.trim(), approverEmail: d.approverEmail.trim() }
        );
        if (r.ok) {
          setSaved(`Saved as version ${r.data.detailsVersion}.`);
          setEditing(false);
          router.refresh();
        } else setError(r.error.message);
      } catch {
        setError(ONBOARDING_COPY.genericError);
      }
    });
  };

  const field = "h-11 font-normal";
  return (
    <div className="space-y-3 text-sm">
      {!editing ? (
        <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[13rem_1fr]">
          <dt className="text-muted-foreground">Primary focus</dt><dd>{primaryFocusLabel(priorities.primaryFocus)}</dd>
          <dt className="text-muted-foreground">Minimum property value</dt><dd className="tabular-nums">{priorities.minPropertyValueUsd ? usd(priorities.minPropertyValueUsd) : "No minimum"}</dd>
          <dt className="text-muted-foreground">Additional opportunity</dt><dd>{priorities.additionalOpportunity || "None"}</dd>
          <dt className="text-muted-foreground">Market</dt><dd>{priorities.market}</dd>
          <dt className="text-muted-foreground">Main contact</dt><dd>{contacts.primaryName} · {contacts.primaryEmail}</dd>
          <dt className="text-muted-foreground">Approves public changes</dt><dd>{contacts.approverIsPrimary ? `Same as ${contacts.primaryName}` : contacts.approverName}</dd>
        </dl>
      ) : (
        <form
          noValidate
          className="grid gap-3 sm:grid-cols-2"
          onSubmit={(ev) => {
            ev.preventDefault();
            save();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-focus`}>Primary focus</Label>
            <Select value={d.focus} onValueChange={(v) => setD({ ...d, focus: v as PrimaryFocus })}>
              <SelectTrigger id={`${id}-focus`} className="w-full data-[size=default]:h-11"><SelectValue /></SelectTrigger>
              <SelectContent>{PRIMARY_FOCUS_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-min`}>Minimum property value ($)</Label>
            <Input id={`${id}-min`} inputMode="numeric" placeholder="No minimum" className={field} value={d.min} onChange={(e) => setD({ ...d, min: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-opp`}>Additional opportunity</Label>
            <Input id={`${id}-opp`} placeholder="None" maxLength={200} className={field} value={d.opportunity} onChange={(e) => setD({ ...d, opportunity: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-market`}>Market</Label>
            <Input id={`${id}-market`} maxLength={200} className={field} value={d.market} onChange={(e) => setD({ ...d, market: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-name`}>Main contact</Label>
            <Input id={`${id}-name`} autoComplete="name" maxLength={200} className={field} value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-email`}>Email</Label>
            <Input id={`${id}-email`} type="email" autoComplete="email" maxLength={320} className={field} value={d.email} onChange={(e) => setD({ ...d, email: e.target.value })} />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <label className="flex items-center gap-2">
              <input type="checkbox" className="size-4 accent-foreground" checked={d.approverIsPrimary} onChange={(e) => setD({ ...d, approverIsPrimary: e.target.checked })} />
              The main contact approves public changes
            </label>
          </div>
          {!d.approverIsPrimary && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-appr`}>Approver</Label>
                <Input id={`${id}-appr`} maxLength={200} className={field} value={d.approverName} onChange={(e) => setD({ ...d, approverName: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor={`${id}-appr-email`}>Approver email (optional)</Label>
                <Input id={`${id}-appr-email`} type="email" maxLength={320} className={field} value={d.approverEmail} onChange={(e) => setD({ ...d, approverEmail: e.target.value })} />
              </div>
            </>
          )}
          <div className="flex flex-col gap-2 sm:col-span-2 sm:flex-row">
            <Button type="submit" className="h-11" disabled={pending}>{pending ? "Saving…" : "Save correction"}</Button>
            <Button type="button" variant="ghost" className="h-11" disabled={pending} onClick={() => { setEditing(false); setError(null); }}>Cancel</Button>
          </div>
        </form>
      )}
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {saved && !editing && <p className="text-muted-foreground" aria-live="polite">{saved}</p>}
      <p className="text-xs text-muted-foreground">
        Version {detailsVersion}. {canCorrect ? "Corrections are saved as a new version; earlier versions are kept." : "Your approver can update these details."}
      </p>
      {canCorrect && !editing && (
        <Button variant="outline" className="h-11" onClick={() => { setSaved(null); setEditing(true); }}>Update details</Button>
      )}
    </div>
  );
}
