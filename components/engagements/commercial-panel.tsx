/**
 * Founder commercial view (spec 140): one section that answers "where is this
 * deal and what do I do next" — offer, quote, agreement, payment, market,
 * exclusivity, onboarding, engagement — with the low-friction actions for
 * the current stage. Server component over `CommercialState`; rendered on
 * the prospect page and the client engagement page.
 */
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Section, Stat, StatGrid } from "@/components/layout/page";
import { formatDate } from "@/lib/format";
import { usd } from "@/lib/pricing/policy";
import type { CommercialState } from "@/lib/engagements/commercial";
import { activationPrerequisites } from "@/lib/engagements/commercial";
import type { OnboardingPrefill } from "@/lib/engagements/onboarding-intake";
import {
  ActivateExclusivityButton,
  AgreementSentDialog,
  AgreementSignedDialog,
  InstallmentPaymentDialog,
  InvoiceScheduleButton,
  MarkActiveButton,
  MarkPresentedDialog,
  MarketDefinitionInline,
  OnboardingIntakeDialog,
  PrepareAgreementButton,
  PrepareQuoteButton,
  QuoteOutcomeDialog,
  SignFromQuoteDialog,
  StartOnboardingButton,
  VoidAgreementDialog,
} from "@/components/engagements/commercial-controls";

const human = (s: string | null | undefined) => (s ?? "—").replace(/_/g, " ").toLowerCase();
const cents = (c: number) => usd(c / 100);

export function CommercialPanel({ state, prefill, today }: { state: CommercialState; prefill: OnboardingPrefill | null; today: string }) {
  const s = state;
  const q = s.quote;
  const a = s.agreement;
  const pay = s.payment;
  const prereq = activationPrerequisites(s);
  const stageDone = s.stage === "ACTIVE" || s.stage === "COMPLETED";
  return (
    <Section
      title="Commercial state"
      description={<>Stage <Badge variant={stageDone ? "default" : "secondary"}>{human(s.stage)}</Badge> · Next: {s.nextAction}</>}
      actions={
        <div className="flex flex-wrap gap-2">
          {s.prospectId && !q && !s.engagementId && <PrepareQuoteButton prospectId={s.prospectId} />}
          {q && q.status === "draft" && <MarkPresentedDialog quoteId={q.id} />}
          {q && q.status === "presented" && !s.engagementId && <QuoteOutcomeDialog quoteId={q.id} />}
          {s.prospectId && q && (q.status === "presented" || q.status === "accepted") && !s.engagementId && (
            <SignFromQuoteDialog prospectId={s.prospectId} quoteId={q.id} defaultStart={today} businessName={s.businessName} />
          )}
          {s.engagementId && s.engagementStage === "signed" && (
            <>
              {!s.market.definitionConfirmed && <MarketDefinitionInline engagementId={s.engagementId} marketName={s.market.name} current={s.market.definition} />}
              {s.market.definitionConfirmed && (!a || a.status === "draft") && <PrepareAgreementButton engagementId={s.engagementId} regenerate={Boolean(a)} />}
              {a && a.status === "draft" && <AgreementSentDialog agreementId={a.id} />}
              {a && (a.status === "draft" || a.status === "sent") && <AgreementSignedDialog agreementId={a.id} />}
              {a && a.status === "sent" && <VoidAgreementDialog agreementId={a.id} />}
              {s.contractStatus === "signed" && s.installments.some((i) => !i.invoiced) && <InvoiceScheduleButton engagementId={s.engagementId} />}
              {s.installments.some((i) => i.invoiced && !i.paid) && <InstallmentPaymentDialog engagementId={s.engagementId} installments={s.installments} />}
              {pay?.activationPaymentReceived && s.contractStatus === "signed" && <StartOnboardingButton engagementId={s.engagementId} ready />}
            </>
          )}
          {s.engagementId && s.engagementStage === "onboarding" && (
            <>
              {prefill && <OnboardingIntakeDialog prefill={prefill} />}
              {s.market.definitionConfirmed && s.exclusivity.status === "reserved" && <ActivateExclusivityButton engagementId={s.engagementId} />}
              {s.installments.some((i) => i.invoiced && !i.paid) && <InstallmentPaymentDialog engagementId={s.engagementId} installments={s.installments} />}
              {s.onboarding?.complete && <MarkActiveButton engagementId={s.engagementId} />}
            </>
          )}
          {s.engagementId && s.engagementStage === "active" && s.installments.some((i) => i.invoiced && !i.paid) && (
            <InstallmentPaymentDialog engagementId={s.engagementId} installments={s.installments} />
          )}
        </div>
      }
    >
      <StatGrid columns={4}>
        <Stat label="Offer" value={s.offer.label} hint={`${s.offer.billing} · ${s.offer.policyVersion} · ${s.offer.source === "current_policy" ? "current policy (no quote yet)" : `from ${s.offer.source}`}`} />
        <Stat label="Quote" value={q ? human(q.status) : "none"} hint={q ? `${usd(q.totalFeeUsd)} / ${q.termDays} days · ${q.presentedAt ? `presented ${formatDate(q.presentedAt)}` : "not presented"}` : "prepare one when asked"} />
        <Stat label="Agreement" value={a ? human(a.status) : s.engagementId ? "not prepared" : "—"} hint={a ? `${a.templateVersion} · legal review ${a.legalReviewStatus}${a.signedRef ? ` · ${a.signedRef}` : ""}` : s.engagementId ? (s.market.definitionConfirmed ? "ready to prepare" : "confirm the market definition first") : "after the engagement is recorded"} />
        <Stat label="Payment" value={pay ? human(pay.status) : "—"} hint={pay ? `${cents(pay.receivedCents)} paid · ${cents(pay.balanceCents)} remaining of ${cents(pay.contractTotalCents)}` : "no engagement yet"} />
        <Stat label="Market" value={s.market.name || "—"} hint={s.engagementId ? (s.market.definitionConfirmed ? "definition confirmed" : "definition NOT confirmed") : "prospect's launch market"} />
        <Stat label="Exclusivity" value={s.engagementId ? human(s.exclusivity.status) : s.exclusivity.conflict ? "conflict" : "available"} hint={s.exclusivity.conflict ? `CONFLICT: ${s.exclusivity.detail}` : s.exclusivity.detail || "no conflict"} />
        <Stat label="Onboarding" value={s.onboarding ? (s.onboarding.complete ? "complete" : `${s.onboarding.open.length} open`) : "—"} hint={s.onboarding && !s.onboarding.complete ? s.onboarding.open.slice(0, 3).join("; ") : s.engagementId ? "checklist derived from the record" : "after activation payment"} />
        <Stat label="Engagement" value={s.engagementStage ? human(s.engagementStage) : "none"} hint={s.engagementId ? (prereq.ready ? "activation prerequisites met" : `to activate: ${prereq.missing.join("; ")}`) : "created from the accepted quote"} />
      </StatGrid>
      {s.installments.length > 0 && (
        <ul className="mt-3 divide-y rounded-md border text-sm">
          {s.installments.map((i) => (
            <li key={i.invoiceId} className="flex flex-wrap items-center justify-between gap-2 p-2">
              <span>Installment {i.n} · {i.invoiceId} · {i.label}</span>
              <span className="tabular-nums text-xs text-muted-foreground">{usd(i.amountUsd)} · due {i.dueOn} · {i.paid ? "PAID" : i.invoiced ? "invoiced, unpaid" : "not invoiced"}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted-foreground">
        Monthly equivalent {usd(s.offer.monthlyEquivalentUsd)} (one installment). Contracted total {usd(s.offer.totalUsd)} over {s.offer.termDays} days — not annual revenue, no automatic renewal.
        {s.projectId && <> · <Link className="underline" href={`/projects/${s.projectId}/engagement`}>Engagement page</Link></>}
        {s.prospectId && <> · <Link className="underline" href={`/prospects/${s.prospectId}`}>Prospect</Link></>}
      </p>
    </Section>
  );
}
