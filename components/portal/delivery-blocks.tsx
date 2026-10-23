import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";
import type { Interval, RateView, StepState } from "@/lib/engagements/delivery-rules";

/**
 * Client-portal building blocks (spec 154). Every number carries its
 * denominator, instrument, window and versions; absence says "pending",
 * never zero. Technical detail sits behind <details> expanders.
 */

export const pctText = (v: number): string => `${Math.round(v * 1000) / 10}%`;
const dateText = (iso: string | null | undefined): string => (iso ? formatDate(new Date(iso)) : "unknown date");
export const dayText = (iso: string): string => formatDate(new Date(`${iso}T12:00:00Z`));

export function IntervalText({ interval }: { interval: Interval | null }) {
  if (!interval) return null;
  return <span className="text-muted-foreground"> (plausible range {pctText(interval.low)}–{pctText(interval.high)})</span>;
}

/** "Recommended in 19 of 256 valid answers (7.4%)" + the instrument line. */
export function RateStatement({ rate, heading }: { rate: RateView; heading: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{heading}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">
        Recommended in {rate.recommended} of {rate.answers} answers
      </p>
      <p className="text-sm tabular-nums">
        {pctText(rate.rate)}
        <IntervalText interval={rate.interval} /> · {rate.distinctQuestions} of {rate.questions} questions
      </p>
      <InstrumentDetails rate={rate} />
    </div>
  );
}

export function InstrumentDetails({ rate }: { rate: RateView }) {
  return (
    <details className="mt-2 text-xs text-muted-foreground">
      <summary className="cursor-pointer rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">How this was measured</summary>
      <ul className="mt-1 space-y-0.5 pl-4">
        <li>Instrument: {rate.providerLabel}{rate.models.length > 0 ? ` — ${rate.models.join(", ")}` : ""}</li>
        <li>Each of {rate.questions} questions asked {rate.repetitions} time(s); {rate.answers} valid answers counted</li>
        <li>Captured: {dateText(rate.capturedAt)}</li>
        <li>Scoring {rate.scoringVersion} · method {rate.methodologyVersion}</li>
        <li>The range treats each answer as independent; answers to the same question are related, so the real uncertainty is wider.</li>
      </ul>
    </details>
  );
}

export function Caveats({ caveats }: { caveats: readonly string[] }) {
  return (
    <details className="rounded-md border p-3 text-sm">
      <summary className="cursor-pointer font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">What these numbers do and don&apos;t mean</summary>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
        {caveats.map((c) => <li key={c}>{c}</li>)}
      </ul>
    </details>
  );
}

export function PendingResults({ nextMeasurementOn, protocolAccepted }: { nextMeasurementOn: string | null; protocolAccepted: boolean }) {
  return (
    <div className="rounded-md border border-dashed p-4 text-sm">
      <p className="font-medium">Starting point not measured yet</p>
      <p className="mt-1 text-muted-foreground">
        {protocolAccepted
          ? "The agreed questions will be measured, checked by a person and locked as your starting point. Results appear here after that — there is no score before then."
          : "First we agree the questions and how success is measured. Then we measure your starting point. There is no score before then."}
        {protocolAccepted && nextMeasurementOn ? ` The next scheduled measurement is ${dayText(nextMeasurementOn)}.` : ""}
      </p>
    </div>
  );
}

const STEP_BADGE: Record<StepState, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  done: { label: "Done", variant: "outline" },
  current: { label: "Now", variant: "default" },
  blocked: { label: "Waiting", variant: "destructive" },
  upcoming: { label: "Later", variant: "secondary" },
};

export function StepList({ steps }: { steps: { key: string; label: string; state: StepState }[] }) {
  return (
    <ol className="space-y-1.5">
      {steps.map((s, n) => (
        <li key={s.key} className="flex items-center gap-3 text-sm">
          <span className="w-5 text-right tabular-nums text-muted-foreground">{n + 1}.</span>
          <span className={s.state === "upcoming" ? "text-muted-foreground" : ""}>{s.label}</span>
          <Badge variant={STEP_BADGE[s.state].variant}>{STEP_BADGE[s.state].label}</Badge>
        </li>
      ))}
    </ol>
  );
}

export function SectionCard({ title, children, id, action }: { title: string; children: React.ReactNode; id?: string; action?: { href: string; label: string } }) {
  return (
    <section id={id} aria-labelledby={id ? `${id}-title` : undefined} className="rounded-md border p-4">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 id={id ? `${id}-title` : undefined} className="text-sm font-medium">{title}</h2>
        {action && <Link href={action.href} className="shrink-0 text-xs text-muted-foreground underline-offset-2 hover:underline">{action.label}</Link>}
      </div>
      {children}
    </section>
  );
}

export function NoEngagement() {
  return (
    <p className="rounded-md border border-dashed p-8 text-sm text-muted-foreground">
      Your program is being set up. Your contact at Recommended First will let you know when there is something to see here.
    </p>
  );
}
