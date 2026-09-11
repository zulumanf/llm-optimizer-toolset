"use client";

/**
 * Spec 140 founder actions along the purchase path. Every dialog states what
 * it records and that nothing is sent or charged by the platform: sending the
 * quote, the agreement and the invoice is the founder's own manual act.
 */
import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import * as actions from "@/app/commercial/actions";
import type { ActionResult } from "@/lib/actions/result";
import { PRICING_OBJECTIONS, QUOTE_RESPONSE_STATUSES, activePricingPolicy, offerLabel, billingLabel, pricingReplyLines } from "@/lib/pricing/policy";
import { ENTITY_TYPES, type OnboardingPrefill } from "@/lib/engagements/onboarding-intake";

const human = (s: string) => s.replace(/_/g, " ");

function ActionDialog({ trigger, title, children, onSubmit, submitLabel = "Save", variant = "outline" }: { trigger: string; title: string; children: ReactNode; onSubmit: () => Promise<ActionResult<unknown>>; submitLabel?: string; variant?: "outline" | "default" | "destructive" | "secondary" }) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><Button size="sm" variant={variant}>{trigger}</Button></DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-3">{children}</div>
        <DialogFooter>
          <Button disabled={pending} onClick={() => start(async () => { const r = await onSubmit(); if (r.ok) { toast.success(`${title}: done.`); setOpen(false); } else toast.error(r.error.message); })}>
            {pending ? "Working…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="space-y-1"><Label className="text-xs">{label}</Label>{children}</div>;
}

function Pick({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: readonly string[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>{options.map((o) => <SelectItem key={o} value={o}>{human(o)}</SelectItem>)}</SelectContent>
    </Select>
  );
}

export function OneClick({ label, onClick, variant = "outline" }: { label: string; onClick: () => Promise<ActionResult<unknown>>; variant?: "outline" | "default" | "destructive" | "secondary" }) {
  const [pending, start] = useTransition();
  return (
    <Button size="sm" variant={variant} disabled={pending} onClick={() => start(async () => { const r = await onClick(); if (r.ok) toast.success(`${label}: done.`); else toast.error(r.error.message); })}>
      {pending ? "Working…" : label}
    </Button>
  );
}

// ---------------------------------------------------------------- quotes

export function PrepareQuoteButton({ prospectId }: { prospectId: string }) {
  const p = activePricingPolicy();
  return (
    <ActionDialog trigger="Prepare quote" title="Prepare quote (current offer)" submitLabel="Prepare" onSubmit={() => actions.prepareQuote({ prospectId })}>
      <p className="text-sm">{p.offerName}: <strong>{offerLabel(p)}</strong> · billed {billingLabel(p)} · {p.version}</p>
      <p className="text-xs text-muted-foreground">Approved reply when asked the price:</p>
      <pre className="whitespace-pre-wrap rounded-md border p-2 text-xs">{pricingReplyLines(p).join("\n")}</pre>
      <p className="text-xs text-muted-foreground">Records a draft quote under the current policy. Nothing is sent. The terms freeze when you mark it presented.</p>
    </ActionDialog>
  );
}

export function MarkPresentedDialog({ quoteId }: { quoteId: string }) {
  const [channel, setChannel] = useState("email");
  return (
    <ActionDialog trigger="Mark presented" title="Mark quote presented" onSubmit={() => actions.markQuotePresented({ quoteId, channel })}>
      <Field label="How it was presented"><Pick value={channel} onChange={setChannel} options={["email", "call", "meeting", "manual"]} /></Field>
      <p className="text-xs text-muted-foreground">Only after you actually sent or said the price. From here the quote amount, term and billing are frozen; a later policy change never touches it.</p>
    </ActionDialog>
  );
}

export function QuoteOutcomeDialog({ quoteId }: { quoteId: string }) {
  const [status, setStatus] = useState<string>("accepted");
  const [objection, setObjection] = useState<string>("UNKNOWN");
  const [summary, setSummary] = useState("");
  return (
    <ActionDialog trigger="Record response" title="Record the prospect's response" onSubmit={() => actions.recordQuoteOutcome({ quoteId, status, objections: status === "declined" ? [objection] : [], responseSummary: summary || undefined })}>
      <Field label="Response"><Pick value={status} onChange={setStatus} options={QUOTE_RESPONSE_STATUSES} /></Field>
      {status === "declined" && <Field label="Main objection"><Pick value={objection} onChange={setObjection} options={PRICING_OBJECTIONS} /></Field>}
      <Field label="Their words (short)"><Textarea rows={2} value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
    </ActionDialog>
  );
}

export function SignFromQuoteDialog({ prospectId, quoteId, defaultStart, businessName }: { prospectId: string; quoteId: string; defaultStart: string; businessName: string }) {
  const [startsOn, setStartsOn] = useState(defaultStart);
  const [legalName, setLegalName] = useState(businessName);
  const [contact, setContact] = useState("");
  return (
    <ActionDialog trigger="Record signed engagement from quote" title="Record engagement from the accepted quote" submitLabel="Create engagement" variant="default"
      onSubmit={() => actions.signClientFromQuote({ prospectId, quoteId, startsOn, clientLegalName: legalName.trim() || undefined, primaryContactName: contact.trim() || undefined })}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Effective / start date"><Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></Field>
        <Field label="Client legal / business name"><Input value={legalName} onChange={(e) => setLegalName(e.target.value)} /></Field>
      </div>
      <Field label="Primary contact (name)"><Input value={contact} onChange={(e) => setContact(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Terms come from the frozen quote — nothing to retype. This creates the client project, the commercial record and the territory hold, and plans the remeasurements. Idempotent: a retry returns the same engagement. Nothing is sent or charged.</p>
    </ActionDialog>
  );
}

// ------------------------------------------------------------- agreement

export function MarketDefinitionInline({ engagementId, marketName, current }: { engagementId: string; marketName: string; current: string | null }) {
  const [def, setDef] = useState(current ?? "");
  return (
    <ActionDialog trigger={current ? "Edit market definition" : "Confirm market definition"} title={`Market definition — ${marketName}`} onSubmit={() => actions.confirmMarketDefinition({ engagementId, definition: def })}>
      <Field label="Boundary in words (city vs metro vs county; what is in, what is out)"><Textarea rows={4} value={def} onChange={(e) => setDef(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Founder decision. Never derived from the market name. The agreement quotes this text; exclusivity activates only on it.</p>
    </ActionDialog>
  );
}

export function PrepareAgreementButton({ engagementId, regenerate }: { engagementId: string; regenerate: boolean }) {
  return <OneClick label={regenerate ? "Regenerate draft agreement" : "Prepare agreement"} onClick={() => actions.prepareAgreement({ engagementId })} />;
}

export function AgreementSentDialog({ agreementId }: { agreementId: string }) {
  const [channel, setChannel] = useState("email");
  return (
    <ActionDialog trigger="Mark agreement sent" title="Agreement sent" onSubmit={() => actions.markAgreementSent({ agreementId, channel })}>
      <Field label="Sent how"><Pick value={channel} onChange={setChannel} options={["email", "docusign", "other"]} /></Field>
      <p className="text-xs text-muted-foreground">Record only after you sent it through the approved process. The artifact freezes; it is never regenerated over.</p>
    </ActionDialog>
  );
}

export function AgreementSignedDialog({ agreementId }: { agreementId: string }) {
  const [ref, setRef] = useState("");
  return (
    <ActionDialog trigger="Record signed agreement" title="Signed agreement received" variant="default" onSubmit={() => actions.recordAgreementSigned({ agreementId, signedRef: ref })}>
      <Field label="Signed copy reference (Drive link, e-sign id, filename)"><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Sets the engagement contract state to signed with this reference in one step.</p>
    </ActionDialog>
  );
}

export function VoidAgreementDialog({ agreementId }: { agreementId: string }) {
  const [reason, setReason] = useState("");
  return (
    <ActionDialog trigger="Void agreement" title="Void this agreement" variant="destructive" onSubmit={() => actions.voidAgreement({ agreementId, reason })}>
      <Field label="Reason (recorded)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    </ActionDialog>
  );
}

// -------------------------------------------------------------- payments

export function InvoiceScheduleButton({ engagementId }: { engagementId: string }) {
  return <OneClick label="Create invoice schedule" onClick={() => actions.createInvoiceSchedule({ engagementId })} />;
}

export function InstallmentPaymentDialog({ engagementId, installments }: { engagementId: string; installments: { n: number; amountUsd: number; dueOn: string; invoiceId: string; paid: boolean }[] }) {
  const open = installments.filter((i) => !i.paid);
  const [n, setN] = useState(String(open[0]?.n ?? 1));
  const [ref, setRef] = useState("");
  const chosen = installments.find((i) => i.n === Number(n));
  return (
    <ActionDialog trigger="Record installment payment" title="Payment received" variant="default" onSubmit={() => actions.recordInstallmentPayment({ engagementId, installment: Number(n), reference: ref || undefined })}>
      <Field label="Installment"><Pick value={n} onChange={setN} options={installments.map((i) => String(i.n))} /></Field>
      {chosen && <p className="text-sm">{chosen.invoiceId} · ${chosen.amountUsd.toLocaleString("en-US")} · due {chosen.dueOn}{chosen.paid ? " · already paid" : ""}</p>}
      <Field label="Payment reference (bank / provider id)"><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Manual confirmation of money that landed. The same installment recorded twice is one event.</p>
    </ActionDialog>
  );
}

// ------------------------------------------------------------- onboarding

export function OnboardingIntakeDialog({ prefill }: { prefill: OnboardingPrefill }) {
  const [f, setF] = useState({
    legalName: prefill.legalName,
    brandName: prefill.brandName,
    entityType: prefill.entityType as string,
    teamLead: prefill.teamLead,
    brokerage: prefill.brokerage,
    website: prefill.website,
    profileUrls: prefill.profileUrls.join("\n"),
    primaryContactName: prefill.primaryContactName,
    contactEmail: prefill.contactEmail,
    implementationContact: "",
    marketDefinition: prefill.marketDefinition,
    priorities: "",
    websiteControl: "client_can_delegate",
    weCanChangeDirectly: "",
    requiresClientApproval: "",
    terminology: "",
    competitorsConfirmed: "",
  });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const lines = (s: string) => s.split(/\n|,/).map((x) => x.trim()).filter(Boolean);
  return (
    <ActionDialog trigger="Onboarding intake" title="Onboarding intake (prefilled from the record)" submitLabel="Record intake" variant="default"
      onSubmit={() => actions.completeOnboardingIntake({
        engagementId: prefill.engagementId,
        legalName: f.legalName, brandName: f.brandName, entityType: f.entityType, teamLead: f.teamLead, brokerage: f.brokerage,
        website: f.website, profileUrls: lines(f.profileUrls), primaryContactName: f.primaryContactName, contactEmail: f.contactEmail,
        implementationContact: f.implementationContact, marketDefinition: f.marketDefinition, priorities: lines(f.priorities),
        websiteControl: f.websiteControl, weCanChangeDirectly: f.weCanChangeDirectly, requiresClientApproval: f.requiresClientApproval,
        terminology: lines(f.terminology), competitorsConfirmed: lines(f.competitorsConfirmed),
      })}>
      <p className="text-xs text-muted-foreground">Prefilled: {prefill.prefilled.length > 0 ? prefill.prefilled.join(", ") : "nothing"}. Ask the client only for what is empty or wrong.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Legal / business name *"><Input value={f.legalName} onChange={set("legalName")} /></Field>
        <Field label="Public brand / team name *"><Input value={f.brandName} onChange={set("brandName")} /></Field>
        <Field label="Entity type"><Pick value={f.entityType} onChange={(v) => setF({ ...f, entityType: v })} options={ENTITY_TYPES} /></Field>
        <Field label="Team lead / principal"><Input value={f.teamLead} onChange={set("teamLead")} /></Field>
        <Field label="Brokerage affiliation"><Input value={f.brokerage} onChange={set("brokerage")} /></Field>
        <Field label="Official website *"><Input value={f.website} onChange={set("website")} /></Field>
        <Field label="Primary contact *"><Input value={f.primaryContactName} onChange={set("primaryContactName")} /></Field>
        <Field label="Contact email *"><Input value={f.contactEmail} onChange={set("contactEmail")} /></Field>
      </div>
      <Field label="Important profile URLs (one per line)"><Textarea rows={2} value={f.profileUrls} onChange={set("profileUrls")} /></Field>
      <Field label={`Market boundary * — ${prefill.marketName}${prefill.marketDefinitionConfirmed ? " (confirmed)" : ""}`}><Textarea rows={3} value={f.marketDefinition} onChange={set("marketDefinition")} /></Field>
      <Field label="Top priorities * (areas / focus, one per line)"><Textarea rows={2} value={f.priorities} onChange={set("priorities")} /></Field>
      <Field label="Who controls the website / content *"><Pick value={f.websiteControl} onChange={(v) => setF({ ...f, websiteControl: v })} options={["client_can_delegate", "client_applies_changes", "third_party_vendor"]} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="What we can change directly"><Input value={f.weCanChangeDirectly} onChange={set("weCanChangeDirectly")} /></Field>
        <Field label="What needs client approval"><Input value={f.requiresClientApproval} onChange={set("requiresClientApproval")} /></Field>
      </div>
      <Field label="Implementation contact (if different)"><Input value={f.implementationContact} onChange={set("implementationContact")} /></Field>
      <Field label="Key market terminology (comma-separated)"><Input value={f.terminology} onChange={set("terminology")} /></Field>
      <Field label="Competitors the client confirms (one per line)"><Textarea rows={2} value={f.competitorsConfirmed} onChange={set("competitorsConfirmed")} /></Field>
      <p className="text-xs text-muted-foreground">* required before delivery starts. Writes canonical records only; starts no benchmark, sends nothing.</p>
    </ActionDialog>
  );
}

export function StartOnboardingButton({ engagementId, ready }: { engagementId: string; ready: boolean }) {
  return <OneClick label={ready ? "Start onboarding" : "Start onboarding (gate not met)"} onClick={() => actions.startOnboarding({ engagementId })} variant={ready ? "default" : "outline"} />;
}
export function ActivateExclusivityButton({ engagementId }: { engagementId: string }) {
  return <OneClick label="Activate exclusivity" onClick={() => actions.activateExclusivity({ engagementId })} />;
}
export function MarkActiveButton({ engagementId }: { engagementId: string }) {
  return <OneClick label="Activate engagement" onClick={() => actions.markActive({ engagementId })} variant="default" />;
}
