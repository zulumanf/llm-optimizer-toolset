"use client";

import { useState, useTransition, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import * as actions from "@/app/projects/[id]/engagement/actions";
import type { ActionResult } from "@/lib/actions/result";
import {
  ACCESS_STATUSES,
  BLOCKED_REASONS,
  CLIENT_DECISIONS,
  CONTEXT_KINDS,
  CONTEXT_PROVENANCES,
  CONTRACT_STATUSES,
  DECISION_CHANNELS,
  TASK_CONFIDENCE,
  TASK_CONTROL,
  TASK_SCOPE,
} from "@/lib/engagements/constants";
import { BILLING_KINDS } from "@/lib/engagements/service";

const human = (s: string) => s.replace(/_/g, " ");

/** Shared dialog shell: open state + pending transition + toast, one action. */
function ActionDialog({
  trigger,
  title,
  children,
  onSubmit,
  submitLabel = "Save",
  variant = "outline",
}: {
  trigger: string;
  title: string;
  children: ReactNode;
  onSubmit: () => Promise<ActionResult<unknown>>;
  submitLabel?: string;
  variant?: "outline" | "default" | "destructive" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant={variant}>{trigger}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">{children}</div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const r = await onSubmit();
                if (r.ok) {
                  toast.success(`${title}: done.`);
                  setOpen(false);
                } else toast.error(r.error.message);
              })
            }
          >
            {pending ? "Working…" : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function Pick({ value, onChange, options }: { value: string; onChange: (v: string) => void; options: readonly string[] }) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o} value={o}>{human(o)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** One-click action with a pending state and toast. */
export function ActionButton({
  label,
  onClick,
  variant = "outline",
}: {
  label: string;
  onClick: () => Promise<ActionResult<unknown>>;
  variant?: "outline" | "default" | "destructive" | "secondary";
}) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await onClick();
          if (r.ok) toast.success(`${label}: done.`);
          else toast.error(r.error.message);
        })
      }
    >
      {pending ? "Working…" : label}
    </Button>
  );
}

// ---------------------------------------------------------------- signing

export function SignClientDialog({ projectId, prospectId, defaultStart }: { projectId: string; prospectId: string | null; defaultStart: string }) {
  const [pid, setPid] = useState(prospectId ?? "");
  const [startsOn, setStartsOn] = useState(defaultStart);
  const [termDays, setTermDays] = useState("90");
  const [monthly, setMonthly] = useState("7500");
  const [total, setTotal] = useState("22500");
  const [paymentTerms, setPaymentTerms] = useState("Invoice monthly in advance; first payment before onboarding.");
  const [scope, setScope] = useState(
    "AI recommendation diagnosis over the frozen baseline question set; evidence improvements to owned pages and controlled profiles; implementation of high-confidence changes (with client approval where public); monitoring on a stated cadence; remeasurement on the same instrument at mid-term and end of term."
  );
  const [exclusions, setExclusions] = useState("Not included: general SEO, website redesign, social media management, paid ads, CRM implementation, general marketing.");
  const [override, setOverride] = useState("");
  return (
    <ActionDialog trigger="Record signed engagement" title="Record signed engagement" submitLabel="Sign"
      onSubmit={() =>
        actions.signClient(projectId, {
          prospectId: pid,
          startsOn,
          termDays: Number(termDays),
          monthlyFeeUsd: Number(monthly),
          totalValueUsd: Number(total),
          paymentTerms,
          scopeSummary: scope,
          scopeExclusions: exclusions,
          conflictOverrideRationale: override.trim() || undefined,
        })
      }
    >
      <Field label="Prospect id"><Input value={pid} onChange={(e) => setPid(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Starts on"><Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></Field>
        <Field label="Term (days)"><Input type="number" value={termDays} onChange={(e) => setTermDays(e.target.value)} /></Field>
        <Field label="Monthly fee (USD)"><Input type="number" value={monthly} onChange={(e) => setMonthly(e.target.value)} /></Field>
        <Field label="Total initial value (USD)"><Input type="number" value={total} onChange={(e) => setTotal(e.target.value)} /></Field>
      </div>
      <Field label="Payment terms"><Input value={paymentTerms} onChange={(e) => setPaymentTerms(e.target.value)} /></Field>
      <Field label="Scope (what the fee buys)"><Textarea rows={4} value={scope} onChange={(e) => setScope(e.target.value)} /></Field>
      <Field label="Explicitly out of scope"><Textarea rows={2} value={exclusions} onChange={(e) => setExclusions(e.target.value)} /></Field>
      <Field label="Founder override reason (only if another live client overlaps this market)"><Input value={override} onChange={(e) => setOverride(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Nothing is sent or charged. This records the commercial terms, reserves the territory, and plans the remeasurements.</p>
    </ActionDialog>
  );
}

// ------------------------------------------------------------ commercial

export function ContractDialog({ projectId, engagementId }: { projectId: string; engagementId: string }) {
  const [status, setStatus] = useState<string>("signed");
  const [ref, setRef] = useState("");
  return (
    <ActionDialog trigger="Record contract state" title="Record contract state"
      onSubmit={() => actions.recordContractStatus(projectId, { engagementId, status, contractRef: ref.trim() || undefined })}>
      <Field label="Status"><Pick value={status} onChange={setStatus} options={CONTRACT_STATUSES} /></Field>
      <Field label="Reference (signed PDF location, e-signature id)"><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Contract execution happens outside the platform. Record the truth here; a signed state needs a reference.</p>
    </ActionDialog>
  );
}

export function BillingDialog({ projectId, engagementId, defaultAmount }: { projectId: string; engagementId: string; defaultAmount: number }) {
  const [kind, setKind] = useState<string>("invoice_created");
  const [amount, setAmount] = useState(String(defaultAmount));
  const [due, setDue] = useState("");
  const [invoiceId, setInvoiceId] = useState("");
  const [note, setNote] = useState("");
  return (
    <ActionDialog trigger="Record invoice / payment" title="Record billing event"
      onSubmit={() => actions.recordBillingEvent(projectId, { engagementId, kind, amountUsd: Number(amount), dueDate: due || undefined, externalInvoiceId: invoiceId.trim() || undefined, note })}>
      <Field label="Event"><Pick value={kind} onChange={setKind} options={BILLING_KINDS} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount (USD)"><Input type="number" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Due date"><Input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></Field>
      </div>
      <Field label="Invoice id (same id on invoice and payment links them)"><Input value={invoiceId} onChange={(e) => setInvoiceId(e.target.value)} /></Field>
      <Field label="Note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </ActionDialog>
  );
}

export function MarketDefinitionDialog({ projectId, engagementId, current, marketName }: { projectId: string; engagementId: string; current: string | null; marketName: string }) {
  const [text, setText] = useState(current ?? "");
  return (
    <ActionDialog trigger={current ? "Edit market definition" : "Confirm market definition"} title={`Define "${marketName}"`}
      onSubmit={() => actions.confirmMarketDefinition(projectId, { engagementId, definition: text })}>
      <Field label="Human-reviewed boundary (city limits? metro? county? which neighborhoods?)">
        <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. City of Grand Rapids plus the listed neighborhoods (Eastown, East Hills, Ridgemoor…); excludes Kent County suburbs and the wider West Michigan region." />
      </Field>
      <p className="text-xs text-muted-foreground">Exclusivity activates only after this is confirmed. Never derived from the name.</p>
    </ActionDialog>
  );
}

export function StartOnboardingDialog({ projectId, engagementId, ready }: { projectId: string; engagementId: string; ready: boolean }) {
  const [reason, setReason] = useState("");
  return (
    <ActionDialog trigger="Start onboarding" title="Start onboarding" variant={ready ? "default" : "outline"}
      onSubmit={() => actions.startOnboarding(projectId, { engagementId, overrideReason: reason.trim() || undefined })}>
      <p className="text-sm">{ready ? "The commercial gate is clear (signed contract + payment recorded)." : "The commercial gate is not clear. An admin may override the payment condition with a written reason — never the contract."}</p>
      {!ready && <Field label="Founder override reason"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
    </ActionDialog>
  );
}

// --------------------------------------------------------------- context

export function ContextItemDialog({ projectId, engagementId }: { projectId: string; engagementId: string }) {
  const [kind, setKind] = useState<string>("priority_area");
  const [label, setLabel] = useState("");
  const [provenance, setProvenance] = useState<string>("client_confirmed");
  const [access, setAccess] = useState<string>("requested");
  const [ref, setRef] = useState("");
  return (
    <ActionDialog trigger="Add context item" title="Add client context"
      onSubmit={() => actions.addContextItem(projectId, { engagementId, kind, label, provenance, accessStatus: kind === "access" ? access : undefined, sourceRef: ref.trim() || undefined })}>
      <Field label="Kind"><Pick value={kind} onChange={setKind} options={CONTEXT_KINDS} /></Field>
      <Field label="Label"><Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === "access" ? "Website CMS (delegated editor invite)" : "Eastown"} /></Field>
      <Field label="Provenance"><Pick value={provenance} onChange={setProvenance} options={CONTEXT_PROVENANCES} /></Field>
      {kind === "access" && <Field label="Access status"><Pick value={access} onChange={setAccess} options={ACCESS_STATUSES} /></Field>}
      <Field label="Source / URL (optional)"><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Publicly observed ≠ client confirmed ≠ client priority. Never paste credentials here — use delegated access.</p>
    </ActionDialog>
  );
}

export function AccessStatusPicker({ projectId, itemId, value }: { projectId: string; itemId: string; value: string }) {
  const [pending, start] = useTransition();
  return (
    <Select value={value} disabled={pending} onValueChange={(v) => start(async () => { const r = await actions.setAccessStatus(projectId, { itemId, accessStatus: v }); if (!r.ok) toast.error(r.error.message); })}>
      <SelectTrigger className="h-8 w-36"><SelectValue /></SelectTrigger>
      <SelectContent>{ACCESS_STATUSES.map((o) => <SelectItem key={o} value={o}>{human(o)}</SelectItem>)}</SelectContent>
    </Select>
  );
}

// ------------------------------------------------------------------ work

export function NewWorkItemDialog({ projectId, evidence }: { projectId: string; evidence: { kind: string; refId: string; label: string }[] }) {
  const [title, setTitle] = useState("");
  const [observation, setObservation] = useState("");
  const [hypothesis, setHypothesis] = useState("");
  const [confidence, setConfidence] = useState<string>("medium_confidence");
  const [control, setControl] = useState<string>("we_control");
  const [approval, setApproval] = useState<string>("no");
  const [targetUrl, setTargetUrl] = useState("");
  const [evidenceRef, setEvidenceRef] = useState(evidence[0]?.refId ?? "");
  const [note, setNote] = useState("Baseline answers behind this observation.");
  const chosen = evidence.find((e) => e.refId === evidenceRef);
  return (
    <ActionDialog trigger="New work item" title="New evidence-backed work item" variant="default"
      onSubmit={async () => {
        const created = await actions.suggestTask(projectId, {
          projectId,
          title,
          description: observation,
          priority: "p2",
          evidence: chosen ? [{ kind: chosen.kind, refId: chosen.refId, note }] : [],
        });
        if (!created.ok) return created;
        return actions.updateTaskProvenance(projectId, {
          taskId: (created.data as { taskId: string }).taskId,
          observation,
          hypothesis,
          confidence,
          control,
          clientApprovalRequired: approval === "yes",
          targetUrl: targetUrl.trim() || null,
        });
      }}>
      <Field label="Title (the change)"><Input value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
      <Field label="Observation (what the evidence shows)"><Textarea rows={2} value={observation} onChange={(e) => setObservation(e.target.value)} /></Field>
      <Field label="Hypothesis (what we expect, not a promise)"><Textarea rows={2} value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Confidence"><Pick value={confidence} onChange={setConfidence} options={TASK_CONFIDENCE} /></Field>
        <Field label="Control"><Pick value={control} onChange={setControl} options={TASK_CONTROL} /></Field>
        <Field label="Client approval required?"><Pick value={approval} onChange={setApproval} options={["no", "yes"]} /></Field>
        <Field label="Target URL"><Input value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} /></Field>
      </div>
      <Field label="Evidence">
        {evidence.length === 0 ? (
          <p className="text-xs text-destructive">No baseline evidence available — freeze the baseline first. A work item without evidence is an opinion.</p>
        ) : (
          <Select value={evidenceRef} onValueChange={setEvidenceRef}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{evidence.map((e) => <SelectItem key={e.refId} value={e.refId}>{e.label}</SelectItem>)}</SelectContent>
          </Select>
        )}
      </Field>
      <Field label="Evidence note"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </ActionDialog>
  );
}

export function ProvenanceDialog({ projectId, task }: { projectId: string; task: { id: string; observation: string | null; hypothesis: string | null; confidence: string | null; control: string | null; scope: string; clientApproval: string; targetUrl: string | null; beforeState: string | null; afterState: string | null; measurementNote: string | null } }) {
  const [observation, setObservation] = useState(task.observation ?? "");
  const [hypothesis, setHypothesis] = useState(task.hypothesis ?? "");
  const [confidence, setConfidence] = useState<string>(task.confidence ?? "medium_confidence");
  const [control, setControl] = useState<string>(task.control ?? "we_control");
  const [scope, setScope] = useState<string>(task.scope);
  const [approval, setApproval] = useState<string>(task.clientApproval === "not_required" ? "no" : "yes");
  const [targetUrl, setTargetUrl] = useState(task.targetUrl ?? "");
  const [before, setBefore] = useState(task.beforeState ?? "");
  const [after, setAfter] = useState(task.afterState ?? "");
  const [measurement, setMeasurement] = useState(task.measurementNote ?? "Same baseline question set, same provider, after implementation.");
  return (
    <ActionDialog trigger="Provenance" title="Change provenance"
      onSubmit={() => actions.updateTaskProvenance(projectId, { taskId: task.id, observation: observation || null, hypothesis: hypothesis || null, confidence, control, scope, clientApprovalRequired: approval === "yes", targetUrl: targetUrl.trim() || null, beforeState: before || null, afterState: after || null, measurementNote: measurement || null })}>
      <Field label="Observation"><Textarea rows={2} value={observation} onChange={(e) => setObservation(e.target.value)} /></Field>
      <Field label="Hypothesis"><Textarea rows={2} value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Confidence"><Pick value={confidence} onChange={setConfidence} options={TASK_CONFIDENCE} /></Field>
        <Field label="Control"><Pick value={control} onChange={setControl} options={TASK_CONTROL} /></Field>
        <Field label="Scope"><Pick value={scope} onChange={setScope} options={TASK_SCOPE} /></Field>
        <Field label="Client approval required?"><Pick value={approval} onChange={setApproval} options={["no", "yes"]} /></Field>
      </div>
      <Field label="Target URL / profile"><Input value={targetUrl} onChange={(e) => setTargetUrl(e.target.value)} /></Field>
      <Field label="Before state"><Textarea rows={2} value={before} onChange={(e) => setBefore(e.target.value)} /></Field>
      <Field label="After state (exact change)"><Textarea rows={2} value={after} onChange={(e) => setAfter(e.target.value)} /></Field>
      <Field label="How it will be measured"><Input value={measurement} onChange={(e) => setMeasurement(e.target.value)} /></Field>
    </ActionDialog>
  );
}

export function BlockDialog({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [reason, setReason] = useState<string>("client_input");
  const [note, setNote] = useState("");
  return (
    <ActionDialog trigger="Block" title="Block work item"
      onSubmit={() => actions.blockTask(projectId, { taskId, reason, note })}>
      <Field label="Waiting on"><Pick value={reason} onChange={setReason} options={BLOCKED_REASONS} /></Field>
      <Field label="What exactly is needed"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </ActionDialog>
  );
}

export function UnblockDialog({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [note, setNote] = useState("");
  return (
    <ActionDialog trigger="Unblock" title="Unblock work item"
      onSubmit={() => actions.unblockTask(projectId, { taskId, note })}>
      <Field label="What resolved it"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    </ActionDialog>
  );
}

export function ClientDecisionDialog({ projectId, taskId }: { projectId: string; taskId: string }) {
  const [decision, setDecision] = useState<string>("approved");
  const [channel, setChannel] = useState<string>("email");
  const [note, setNote] = useState("");
  return (
    <ActionDialog trigger="Record client decision" title="Record the client's decision" variant="default"
      onSubmit={() => actions.recordClientDecision(projectId, { taskId, decision, channel, note })}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Decision"><Pick value={decision} onChange={setDecision} options={CLIENT_DECISIONS} /></Field>
        <Field label="Channel"><Pick value={channel} onChange={setChannel} options={DECISION_CHANNELS} /></Field>
      </div>
      <Field label="Their words (quote or summary)"><Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Appended to an immutable decision trail on the task.</p>
    </ActionDialog>
  );
}

// ----------------------------------------------------------- measurement

export function RecordMeasurementDialog({ projectId, engagementId, slots }: { projectId: string; engagementId: string; slots: { id: string; role: string; scheduledFor: string | null }[] }) {
  const [runId, setRunId] = useState("");
  const [slot, setSlot] = useState<string>(slots[0]?.id ?? "adhoc");
  return (
    <ActionDialog trigger="Record remeasurement" title="Record a remeasurement run"
      onSubmit={() => actions.recordMeasurement(projectId, { engagementId, runId, measurementId: slot === "adhoc" ? undefined : slot, role: slot === "adhoc" ? "adhoc" : undefined })}>
      <Field label="Finished run id (same question set, same provider)"><Input value={runId} onChange={(e) => setRunId(e.target.value)} /></Field>
      <Field label="Fills which scheduled slot">
        <Select value={slot} onValueChange={setSlot}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {slots.map((s) => <SelectItem key={s.id} value={s.id}>{human(s.role)} · {s.scheduledFor}</SelectItem>)}
            <SelectItem value="adhoc">ad-hoc</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <p className="text-xs text-muted-foreground">The run is compared to the frozen baseline under the comparability rules. A changed instrument is recorded as non-comparable — never as progress.</p>
    </ActionDialog>
  );
}

// ---------------------------------------------------------- communication

export function UpdateSentDialog({ projectId, engagementId, draft }: { projectId: string; engagementId: string; draft: string }) {
  const [channel, setChannel] = useState<string>("email");
  const [summary, setSummary] = useState(draft);
  return (
    <ActionDialog trigger="Record update sent" title="Record the client update you sent"
      onSubmit={() => actions.recordClientUpdateSent(projectId, { engagementId, channel, summary })}>
      <Field label="Channel"><Pick value={channel} onChange={setChannel} options={["email", "call", "meeting", "portal", "other"]} /></Field>
      <Field label="What was sent"><Textarea rows={10} value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Sending stays with the founder. This records that it happened, for the cadence signal.</p>
    </ActionDialog>
  );
}

// ------------------------------------------------------- renewal / close

export function RenewDialog({ projectId, engagementId, endsOn, monthly, total }: { projectId: string; engagementId: string; endsOn: string; monthly: number; total: number }) {
  const [startsOn, setStartsOn] = useState(endsOn);
  const [termDays, setTermDays] = useState("90");
  const [m, setM] = useState(String(monthly));
  const [t, setT] = useState(String(total));
  return (
    <ActionDialog trigger="Renew" title="Record renewal (new term)" variant="default"
      onSubmit={() => actions.renewEngagement(projectId, { engagementId, startsOn, termDays: Number(termDays), monthlyFeeUsd: Number(m), totalValueUsd: Number(t) })}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="New term starts"><Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></Field>
        <Field label="Term (days)"><Input type="number" value={termDays} onChange={(e) => setTermDays(e.target.value)} /></Field>
        <Field label="Monthly fee (USD)"><Input type="number" value={m} onChange={(e) => setM(e.target.value)} /></Field>
        <Field label="Total value (USD)"><Input type="number" value={t} onChange={(e) => setT(e.target.value)} /></Field>
      </div>
      <p className="text-xs text-muted-foreground">The new term starts as signed and passes its own contract and payment gate. Never automatic.</p>
    </ActionDialog>
  );
}

export function CloseDialog({ projectId, engagementId }: { projectId: string; engagementId: string }) {
  const [outcome, setOutcome] = useState<string>("completed");
  const [reason, setReason] = useState("");
  const [cooldown, setCooldown] = useState("180");
  return (
    <ActionDialog trigger="Close / offboard" title="Close the engagement" variant="destructive" submitLabel="Close engagement"
      onSubmit={() => actions.closeEngagement(projectId, { engagementId, outcome, reason, cooldownDays: Number(cooldown) })}>
      <Field label="Outcome"><Pick value={outcome} onChange={setOutcome} options={["completed", "churned"]} /></Field>
      <Field label="Reason"><Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <Field label="Cold-prospecting cooldown (days)"><Input type="number" value={cooldown} onChange={(e) => setCooldown(e.target.value)} /></Field>
      <p className="text-xs text-muted-foreground">Releases exclusivity on the term end date, closes portal access, cancels planned remeasurements, and flags the former client do-not-contact through the cooldown. Records stay historical.</p>
    </ActionDialog>
  );
}

export function RenewalStatusButtons({ projectId, engagementId }: { projectId: string; engagementId: string }) {
  return (
    <div className="flex gap-2">
      <ActionButton label="Mark renewal offered" onClick={() => actions.setRenewalStatus(projectId, { engagementId, status: "offered" })} />
      <ActionButton label="Mark renewal declined" onClick={() => actions.setRenewalStatus(projectId, { engagementId, status: "declined" })} />
    </div>
  );
}

export function PermissionToggles({ projectId, engagementId, values }: { projectId: string; engagementId: string; values: { caseStudy: boolean; testimonial: boolean; logo: boolean; anonymizedData: boolean } }) {
  const entries: [keyof typeof values, string][] = [["caseStudy", "Case study"], ["testimonial", "Testimonial"], ["logo", "Logo"], ["anonymizedData", "Anonymized data"]];
  return (
    <div className="flex flex-wrap gap-2">
      {entries.map(([key, label]) => (
        <ActionButton key={key} variant={values[key] ? "secondary" : "outline"} label={`${label}: ${values[key] ? "permitted" : "no public use"}`}
          onClick={() => actions.setMarketingPermissions(projectId, { engagementId, [key]: !values[key] })} />
      ))}
    </div>
  );
}
