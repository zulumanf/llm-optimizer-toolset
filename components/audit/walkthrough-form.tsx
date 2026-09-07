"use client";

import { useState, useTransition } from "react";
import { submitReportWalkthroughRequest } from "@/app/report/[slug]/walkthrough/actions";
import type { WalkthroughSlot } from "@/lib/prospects/walkthrough";

/** Pick a day, pick a time, one button. No account, no calendar. */
export function WalkthroughForm({
  reportSlug,
  days,
}: {
  /** The report's clean slug; the browser's session cookie is the credential (spec 134). */
  reportSlug: string;
  days: { dayLabel: string; slots: WalkthroughSlot[] }[];
}) {
  const [day, setDay] = useState(days[0]?.dayLabel ?? "");
  const [slot, setSlot] = useState<string>("");
  const [contact, setContact] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ dayLabel: string; timeLabel: string } | null>(null);
  const [pending, start] = useTransition();
  const current = days.find((d) => d.dayLabel === day);

  if (done) {
    return (
      <div className="rounded-md border p-5">
        <p className="text-lg">Got it. {done.dayLabel}, {done.timeLabel}.</p>
        <p className="mt-2 text-sm text-muted-foreground">Francisco will confirm by email. Nothing else to do.</p>
      </div>
    );
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        if (!slot) {
          setError("Pick a time.");
          return;
        }
        setError(null);
        start(async () => {
          const r = await submitReportWalkthroughRequest({ reportSlug, slotAt: slot, contact: contact || undefined, note: note || undefined });
          if (r.ok) setDone({ dayLabel: r.dayLabel, timeLabel: r.timeLabel });
          else setError(r.error);
        });
      }}
    >
      <fieldset>
        <legend className="text-xs uppercase tracking-wide text-muted-foreground">Day</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {days.map((d) => (
            <button
              key={d.dayLabel}
              type="button"
              onClick={() => { setDay(d.dayLabel); setSlot(""); }}
              aria-pressed={day === d.dayLabel}
              className={`rounded-md border px-3 py-2 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${day === d.dayLabel ? "border-foreground bg-foreground text-background" : "hover:bg-muted"}`}
            >
              {d.dayLabel}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend className="text-xs uppercase tracking-wide text-muted-foreground">Time (your local time)</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {(current?.slots ?? []).map((s) => (
            <button
              key={s.at}
              type="button"
              onClick={() => setSlot(s.at)}
              aria-pressed={slot === s.at}
              className={`rounded-md border px-3 py-2 text-sm tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${slot === s.at ? "border-foreground bg-foreground text-background" : "hover:bg-muted"}`}
            >
              {s.timeLabel}
            </button>
          ))}
        </div>
      </fieldset>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-muted-foreground">Best number or email to confirm (optional)</span>
          <input value={contact} onChange={(e) => setContact(e.target.value)} maxLength={200} className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
        <label className="text-sm">
          <span className="block text-xs uppercase tracking-wide text-muted-foreground">Anything you want covered (optional)</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} className="mt-1 w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
        </label>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div>
        <button
          type="submit"
          disabled={pending}
          data-signal-cta="walkthrough-submit"
          className="inline-flex w-full items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 sm:w-auto"
        >
          {pending ? "Sending…" : "Book this time"}
        </button>
        <p className="mt-2 text-xs text-muted-foreground">15 minutes. Francisco confirms by email.</p>
      </div>
    </form>
  );
}
