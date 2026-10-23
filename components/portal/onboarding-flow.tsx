"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "@/app/login/actions";
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
  type OnboardingStep,
  type PreparedPriorities,
  type PrimaryFocus,
} from "@/lib/engagements/client-onboarding-rules";
import type { OnboardingView } from "@/lib/engagements/client-onboarding";
import type { ActionResult } from "@/lib/actions/result";
import { ONBOARDING_COPY as COPY } from "@/lib/portal/client-copy";
import {
  completeClientOnboarding,
  confirmOnboardingPriorities,
  reopenOnboardingPriorities,
  saveOnboardingPriorities,
} from "@/app/portal/[projectId]/actions";

const STEPS: OnboardingStep[] = ["priorities", "contacts", "done"];
const PRIMARY_BTN = "h-11 w-full px-6 sm:w-auto";
const SECONDARY_BTN = "h-11 w-full sm:w-auto";

/**
 * Required onboarding (spec 155): three calm screens, one obvious action
 * each. Everything is prefilled from the client's records; the client only
 * confirms, corrects, or fills a genuine gap. Staff see the same screens as
 * a preview: buttons step through locally and write nothing.
 */
export function OnboardingFlow({ projectId, view }: { projectId: string; view: OnboardingView }) {
  const [step, setStep] = useState<OnboardingStep>(view.step);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  useEffect(() => {
    // Move focus to the new screen's heading so keyboard and screen-reader
    // users land at the top of what changed (not on the first render).
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  const index = STEPS.indexOf(step);
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-xl flex-col px-5 py-8 sm:py-14">
      <div className="mb-10 sm:mb-14">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">Recommended First</p>
          <form action={signOut}>
            <button type="submit" className="rounded-sm py-1 text-sm text-muted-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              Sign out
            </button>
          </form>
        </div>
        <div className="mt-6 flex items-center gap-3">
          <ol className="flex flex-1 gap-1.5" aria-hidden>
            {STEPS.map((s, n) => (
              <li key={s} className={`h-1 flex-1 rounded-full transition-colors ${n <= index ? "bg-foreground" : "bg-border"}`} />
            ))}
          </ol>
          <p className="shrink-0 text-xs tabular-nums text-muted-foreground" aria-live="polite">
            {COPY.stepLabel(index + 1, STEPS.length)}
          </p>
        </div>
      </div>

      {!view.canRespond && step !== "done" && (
        <p className="mb-6 rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {view.readOnlyReason === "viewer" ? COPY.viewerNote : COPY.previewNote}
        </p>
      )}

      {step === "priorities" && (
        <PrioritiesStep projectId={projectId} view={view} heading={heading} onDone={() => setStep("contacts")} />
      )}
      {step === "contacts" && (
        <ContactsStep projectId={projectId} view={view} heading={heading} onBack={() => setStep("priorities")} onDone={() => setStep("done")} />
      )}
      {step === "done" && <DoneStep projectId={projectId} heading={heading} />}
    </div>
  );
}

function useAction() {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const run = <T,>(fn: () => Promise<ActionResult<T>>, onOk: () => void) => {
    setError(null);
    start(async () => {
      try {
        const r = await fn();
        if (r.ok) {
          onOk();
          router.refresh();
        } else setError(r.error.message);
      } catch {
        setError(COPY.genericError);
      }
    });
  };
  return { pending, error, setError, run };
}

function Heading({ heading, children }: { heading: React.RefObject<HTMLHeadingElement | null>; children: React.ReactNode }) {
  return (
    <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight outline-none">
      {children}
    </h1>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="mt-4 text-sm text-destructive">
      {error}
    </p>
  );
}

function Rows({ children }: { children: React.ReactNode }) {
  return <dl className="mt-8 divide-y rounded-lg border bg-background">{children}</dl>;
}

function Row({ label, children, htmlFor }: { label: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className="grid gap-1 px-4 py-4 sm:grid-cols-[13rem_1fr] sm:items-center sm:gap-4 sm:px-5">
      <dt className="text-sm text-muted-foreground">{htmlFor ? <Label htmlFor={htmlFor} className="font-normal text-muted-foreground">{label}</Label> : label}</dt>
      <dd className="min-w-0 break-words font-medium">{children}</dd>
    </div>
  );
}

function Actions({ children }: { children: React.ReactNode }) {
  return <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">{children}</div>;
}

// ------------------------------------------------------------ screen 1

function PrioritiesStep({ projectId, view, heading, onDone }: { projectId: string; view: OnboardingView; heading: React.RefObject<HTMLHeadingElement | null>; onDone: () => void }) {
  const [values, setValues] = useState<PreparedPriorities>(view.priorities);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ focus: values.primaryFocus, min: values.minPropertyValueUsd ? values.minPropertyValueUsd.toLocaleString("en-US") : "", opportunity: values.additionalOpportunity, market: values.market });
  const { pending, error, setError, run } = useAction();
  const id = useId();

  const startEdit = () => {
    setDraft({ focus: values.primaryFocus, min: values.minPropertyValueUsd ? values.minPropertyValueUsd.toLocaleString("en-US") : "", opportunity: values.additionalOpportunity, market: values.market });
    setError(null);
    setEditing(true);
  };

  const save = () => {
    const min = draft.min.trim() === "" ? null : parseUsdInput(draft.min);
    if (draft.min.trim() !== "" && min === null) return setError("Enter the minimum as an amount, like 300,000.");
    if (!draft.focus) return setError("Choose who you mainly want to reach.");
    const next = { primaryFocus: draft.focus, minPropertyValueUsd: min, additionalOpportunity: draft.opportunity.trim(), market: draft.market.trim() };
    if (next.market.length < 2) return setError("Tell us the area you serve.");
    if (!view.canRespond) {
      setValues(next);
      setEditing(false);
      return;
    }
    run(() => saveOnboardingPriorities(projectId, next), () => {
      setValues(next);
      setEditing(false);
    });
  };

  const confirm = () => {
    if (!view.canRespond) return onDone();
    run(() => confirmOnboardingPriorities(projectId), onDone);
  };

  return (
    <section>
      <Heading heading={heading}>{COPY.welcomeTitle(view.businessName)}</Heading>
      <p className="mt-3 text-muted-foreground">{COPY.welcomeLead}</p>

      {!editing ? (
        <>
          <Rows>
            <Row label="Primary focus">{primaryFocusLabel(values.primaryFocus) || "Not set yet"}</Row>
            <Row label="Minimum property value"><span className="tabular-nums">{values.minPropertyValueUsd ? usd(values.minPropertyValueUsd) : "No minimum"}</span></Row>
            <Row label="Additional opportunity">{values.additionalOpportunity || "None"}</Row>
            <Row label="Market">{values.market}</Row>
          </Rows>
          <ErrorLine error={error} />
          <Actions>
            <Button className={PRIMARY_BTN} onClick={confirm} disabled={pending}>
              {pending ? "Saving…" : "Looks good"}
            </Button>
            <Button variant="ghost" className={SECONDARY_BTN} onClick={startEdit} disabled={pending}>
              Edit details
            </Button>
          </Actions>
        </>
      ) : (
        <form
          noValidate
          onSubmit={(ev) => {
            ev.preventDefault();
            save();
          }}
        >
          <Rows>
            <Row label="Primary focus" htmlFor={`${id}-focus`}>
              <Select value={draft.focus ?? undefined} onValueChange={(v) => setDraft({ ...draft, focus: v as PrimaryFocus })}>
                <SelectTrigger id={`${id}-focus`} className="w-full font-normal data-[size=default]:h-11">
                  <SelectValue placeholder="Choose one" />
                </SelectTrigger>
                <SelectContent>
                  {PRIMARY_FOCUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
            <Row label="Minimum property value" htmlFor={`${id}-min`}>
              <div className="relative">
                <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground" aria-hidden>$</span>
                <Input id={`${id}-min`} inputMode="numeric" autoComplete="off" placeholder="No minimum" className="h-11 pl-7 font-normal tabular-nums" value={draft.min} onChange={(ev) => setDraft({ ...draft, min: ev.target.value })} />
              </div>
            </Row>
            <Row label="Additional opportunity" htmlFor={`${id}-opp`}>
              <Input id={`${id}-opp`} placeholder="None" maxLength={200} className="h-11 font-normal" value={draft.opportunity} onChange={(ev) => setDraft({ ...draft, opportunity: ev.target.value })} />
            </Row>
            <Row label="Market" htmlFor={`${id}-market`}>
              <Input id={`${id}-market`} maxLength={200} required className="h-11 font-normal" value={draft.market} onChange={(ev) => setDraft({ ...draft, market: ev.target.value })} />
            </Row>
          </Rows>
          <ErrorLine error={error} />
          <Actions>
            <Button type="submit" className={PRIMARY_BTN} disabled={pending}>
              {pending ? "Saving…" : "Save changes"}
            </Button>
            <Button type="button" variant="ghost" className={SECONDARY_BTN} onClick={() => { setEditing(false); setError(null); }} disabled={pending}>
              Cancel
            </Button>
          </Actions>
        </form>
      )}
    </section>
  );
}

// ------------------------------------------------------------ screen 2

function ContactsStep({ projectId, view, heading, onBack, onDone }: { projectId: string; view: OnboardingView; heading: React.RefObject<HTMLHeadingElement | null>; onBack: () => void; onDone: () => void }) {
  const known = view.contacts;
  const [c, setC] = useState<OnboardingContacts>({
    ...known,
    // No approver on file → default to "the main contact approves".
    approverIsPrimary: known.approverIsPrimary || (!known.approverName && view.missing.includes("approver")),
  });
  const [editing, setEditing] = useState(false);
  const { pending, error, setError, run } = useAction();
  const id = useId();
  const ask = (field: "primaryName" | "primaryEmail") => editing || view.missing.includes(field);
  // A verified approver is shown, not re-asked, unless the client changes it.
  const approverKnown = Boolean(known.approverName) && !known.approverIsPrimary;
  const askApprover = editing || !approverKnown || c.approverName !== known.approverName;
  const primaryLabel = c.primaryName || "your main contact";

  const submit = () => {
    if (!c.primaryName.trim()) return setError("Tell us who we should work with.");
    if (!c.primaryEmail.trim()) return setError("Add an email address for your main contact.");
    if (!/^\S+@\S+\.\S+$/.test(c.primaryEmail.trim())) return setError("Enter a valid email address.");
    if (!c.approverIsPrimary && !c.approverName.trim()) return setError("Tell us who approves public changes.");
    if (!view.canRespond) return onDone();
    run(() => completeClientOnboarding(projectId, c), onDone);
  };

  const back = () => {
    if (!view.canRespond) return onBack();
    run(() => reopenOnboardingPriorities(projectId), onBack);
  };

  return (
    <section>
      <Heading heading={heading}>{COPY.contactsTitle}</Heading>
      <p className="mt-3 text-muted-foreground">{COPY.contactsLead}</p>
      <form
        noValidate
        onSubmit={(ev) => {
          ev.preventDefault();
          submit();
        }}
      >
        <Rows>
          <Row label="Main contact" htmlFor={ask("primaryName") ? `${id}-name` : undefined}>
            {ask("primaryName") ? (
              <Input id={`${id}-name`} autoComplete="name" placeholder="Full name" required maxLength={200} className="h-11 font-normal" value={c.primaryName} onChange={(ev) => setC({ ...c, primaryName: ev.target.value })} />
            ) : (
              c.primaryName
            )}
          </Row>
          <Row label="Email" htmlFor={ask("primaryEmail") ? `${id}-email` : undefined}>
            {ask("primaryEmail") ? (
              <Input id={`${id}-email`} type="email" autoComplete="email" placeholder="name@yourbusiness.com" aria-invalid={Boolean(error) && !c.primaryEmail.trim()} required maxLength={320} className="h-11 font-normal" value={c.primaryEmail} onChange={(ev) => setC({ ...c, primaryEmail: ev.target.value })} />
            ) : (
              c.primaryEmail
            )}
          </Row>
          <Row label="Approves public changes" htmlFor={!c.approverIsPrimary && askApprover ? `${id}-approver` : undefined}>
            {c.approverIsPrimary ? (
              <span className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span>Same as {primaryLabel}</span>
                <button type="button" className="rounded-sm text-sm font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setC({ ...c, approverIsPrimary: false })}>
                  Someone else
                </button>
              </span>
            ) : askApprover ? (
              <span className="grid gap-2">
                <Input id={`${id}-approver`} placeholder="Name" autoComplete="off" maxLength={200} className="h-11 font-normal" value={c.approverName} onChange={(ev) => setC({ ...c, approverName: ev.target.value })} />
                <Input type="email" aria-label="Approver email (optional)" placeholder="Email (optional)" autoComplete="off" maxLength={320} className="h-11 font-normal" value={c.approverEmail} onChange={(ev) => setC({ ...c, approverEmail: ev.target.value })} />
                <button type="button" className="justify-self-start rounded-sm text-sm font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setC({ ...c, approverIsPrimary: true })}>
                  Same as {primaryLabel}
                </button>
              </span>
            ) : (
              <span>
                {c.approverName}
                {c.approverEmail && <span className="block text-sm font-normal text-muted-foreground">{c.approverEmail}</span>}
              </span>
            )}
          </Row>
        </Rows>
        {!editing && view.missing.length < 3 && (
          <button type="button" className="mt-3 rounded-sm text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => setEditing(true)}>
            Change these details
          </button>
        )}
        <p className="mt-6 text-sm text-muted-foreground">{COPY.contactsFootnote}</p>
        <ErrorLine error={error} />
        <Actions>
          <Button type="submit" className={PRIMARY_BTN} disabled={pending}>
            {pending ? "Saving…" : "Continue"}
          </Button>
          <Button type="button" variant="ghost" className={SECONDARY_BTN} onClick={back} disabled={pending}>
            Back
          </Button>
        </Actions>
      </form>
    </section>
  );
}

// ------------------------------------------------------------ screen 3

function DoneStep({ projectId, heading }: { projectId: string; heading: React.RefObject<HTMLHeadingElement | null> }) {
  return (
    <section>
      <Heading heading={heading}>{COPY.doneTitle}</Heading>
      <p className="mt-3 text-muted-foreground">{COPY.doneLead}</p>
      <ol className="mt-8 space-y-5">
        {COPY.nextSteps.map((s, n) => (
          <li key={s} className="flex items-start gap-4">
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full border bg-background text-sm font-medium tabular-nums" aria-hidden>
              {n + 1}
            </span>
            <span className="pt-0.5">{s}</span>
          </li>
        ))}
      </ol>
      <Actions>
        <Button asChild className={PRIMARY_BTN}>
          <Link href={`/portal/${projectId}`}>Go to my dashboard</Link>
        </Button>
      </Actions>
    </section>
  );
}
