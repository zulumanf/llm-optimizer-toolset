"use client";

/**
 * Operator controls for the client's self-service onboarding (spec 155):
 * prepare the four priorities and the known contacts from records, then
 * share. The client confirms or corrects them in the portal.
 */
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { ActionDialog, Field, OneClick, Pick } from "@/components/engagements/commercial-controls";
import * as a from "@/app/projects/[id]/delivery/actions";
import { PRIMARY_FOCUS_OPTIONS, parseUsdInput, type OnboardingContacts, type PreparedPriorities, type PrimaryFocus } from "@/lib/engagements/client-onboarding-rules";

const NONE = "not_set";

export function PrepareOnboardingDialog({ projectId, engagementId, initial }: { projectId: string; engagementId: string; initial: { priorities: PreparedPriorities; contacts: OnboardingContacts } }) {
  const [focus, setFocus] = useState<string>(initial.priorities.primaryFocus ?? NONE);
  const [min, setMin] = useState(initial.priorities.minPropertyValueUsd ? String(initial.priorities.minPropertyValueUsd) : "");
  const [opportunity, setOpportunity] = useState(initial.priorities.additionalOpportunity);
  const [market, setMarket] = useState(initial.priorities.market);
  const [c, setC] = useState<OnboardingContacts>(initial.contacts);
  return (
    <ActionDialog
      trigger="Prepare client onboarding"
      title="Prepare the client's onboarding"
      submitLabel="Save draft"
      onSubmit={() =>
        a.prepareClientOnboarding(projectId, {
          engagementId,
          priorities: {
            primaryFocus: focus === NONE ? null : (focus as PrimaryFocus),
            minPropertyValueUsd: min.trim() === "" ? null : parseUsdInput(min),
            additionalOpportunity: opportunity,
            market,
          },
          contacts: c,
        })
      }
    >
      <p className="text-xs text-muted-foreground">Prefilled from records. The client sees these as four rows and a contact summary, and confirms or corrects them. Leave a contact blank to ask the client for it.</p>
      <Field label="Primary focus * (required before sharing)">
        <Pick value={focus} onChange={setFocus} options={[NONE, ...PRIMARY_FOCUS_OPTIONS.map((o) => o.value)]} />
      </Field>
      <Field label="Minimum property value (USD, blank = no minimum)"><Input inputMode="numeric" value={min} onChange={(e) => setMin(e.target.value)} /></Field>
      <Field label="Additional opportunity (e.g. a segment they want more of)"><Input value={opportunity} onChange={(e) => setOpportunity(e.target.value)} /></Field>
      <Field label="Market, in the client's words *"><Input value={market} onChange={(e) => setMarket(e.target.value)} /></Field>
      <Field label="Main contact name"><Input value={c.primaryName} onChange={(e) => setC({ ...c, primaryName: e.target.value })} /></Field>
      <Field label="Main contact email"><Input type="email" value={c.primaryEmail} onChange={(e) => setC({ ...c, primaryEmail: e.target.value })} /></Field>
      <Field label="Approver of public changes (blank = ask the client)"><Input value={c.approverIsPrimary ? c.primaryName : c.approverName} disabled={c.approverIsPrimary} onChange={(e) => setC({ ...c, approverName: e.target.value })} /></Field>
      <label className="flex items-center gap-2 text-xs">
        <input type="checkbox" className="size-4 accent-foreground" checked={c.approverIsPrimary} onChange={(e) => setC({ ...c, approverIsPrimary: e.target.checked })} />
        The main contact approves public changes (verified)
      </label>
      {!c.approverIsPrimary && <Field label="Approver email (optional)"><Input type="email" value={c.approverEmail} onChange={(e) => setC({ ...c, approverEmail: e.target.value })} /></Field>}
    </ActionDialog>
  );
}

export function ShareOnboardingButton({ projectId, engagementId }: { projectId: string; engagementId: string }) {
  return <OneClick label="Share with the client" variant="default" onClick={() => a.markOnboardingReady(projectId, { engagementId })} />;
}
