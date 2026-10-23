import Link from "next/link";
import { formatDate } from "@/lib/format";
import type { ClientOverview } from "@/lib/portal/delivery";
import { RateStatement } from "@/components/portal/delivery-blocks";
import { ESTABLISHING_STARTING_POINT, FOCUS_WORK_LEAD, NOTHING_NEEDED, ROADMAP_NOT_YET } from "@/lib/portal/client-copy";

/**
 * The engaged client's Overview (spec 155): four sections and nothing else —
 * this week's focus, progress, what needs you, the latest update. Numbers
 * appear only from a frozen measurement; before the baseline the page says
 * so in words, never with a zero.
 */
export function DeliveryOverview({ o, projectId }: { o: ClientOverview; projectId: string }) {
  const base = `/portal/${projectId}`;
  return (
    <div className="divide-y rounded-lg border bg-background">
      <Block title="This week's focus">
        {o.focus.work.length > 0 ? (
          <>
            <p>{FOCUS_WORK_LEAD}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5">
              {o.focus.work.map((t) => <li key={t}>{t}</li>)}
            </ul>
          </>
        ) : (
          <p>{o.focus.sentence}</p>
        )}
      </Block>

      <Block title="Progress" link={o.progress.published ? { href: `${base}/plan`, label: "View the 90-day plan" } : undefined}>
        {!o.progress.published ? (
          <p className="text-muted-foreground">{ROADMAP_NOT_YET}</p>
        ) : (
          <>
            <p className="tabular-nums">
              {o.progress.completed} of {o.progress.total} planned items delivered{o.day ? ` · day ${o.day} of 90` : ""}
            </p>
            <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
              <Count label="Completed" value={o.progress.completed} />
              <Count label="Ongoing" value={o.progress.ongoing} />
              <Count label="Upcoming" value={o.progress.upcoming} />
            </dl>
          </>
        )}
      </Block>

      <Block title="Needs your attention">
        {o.todos.length === 0 ? (
          <p className="text-muted-foreground">{NOTHING_NEEDED}</p>
        ) : (
          <ul className="space-y-2">
            {o.todos.map((t) => (
              <li key={t.key}>
                <Link href={t.href} className="inline-flex min-h-11 items-center rounded-sm font-medium underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {t.label}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Block>

      <Block
        title="Latest update"
        link={o.latest ? (o.latest.kind === "update" ? { href: `${base}/reports`, label: "Read the full update" } : { href: `${base}/results`, label: "See the details" }) : undefined}
      >
        {!o.latest ? (
          <p className="text-muted-foreground">{o.baselineLocked ? "Your first weekly update arrives at the end of the week." : ESTABLISHING_STARTING_POINT}</p>
        ) : o.latest.kind === "update" ? (
          <>
            <p className="text-sm text-muted-foreground">{o.latest.label} · {formatDate(o.latest.at)}</p>
            <ul className="mt-2 space-y-1">
              {o.latest.lines.map((l) => <li key={l} className="line-clamp-2">{l}</li>)}
            </ul>
            {!o.baselineLocked && <p className="mt-3 text-sm text-muted-foreground">{ESTABLISHING_STARTING_POINT}</p>}
          </>
        ) : (
          <RateStatement rate={o.latest.rate} heading={o.latest.isBaseline ? "Your starting point" : "Latest verified measurement"} />
        )}
      </Block>
    </div>
  );
}

function Block({ title, link, children }: { title: string; link?: { href: string; label: string }; children: React.ReactNode }) {
  return (
    <section className="px-5 py-6 sm:px-7">
      <h2 className="mb-2 text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
      {link && (
        <p className="mt-3 text-sm">
          <Link href={link.href} className="rounded-sm underline underline-offset-4 hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {link.label}
          </Link>
        </p>
      )}
    </section>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
