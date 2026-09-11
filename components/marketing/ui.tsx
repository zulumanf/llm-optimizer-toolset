/**
 * Marketing design-system primitives (spec 061). Server components only —
 * the marketing site is static prose and figures; client JS is reserved for
 * the audit demo, the nav toggle, and the request form.
 *
 * Design rules (audit-page-design skill): existing tokens, two colors with
 * meaning (destructive = the gap, primary = the action), tabular figures,
 * SVG presentation attributes for bars (never inline styles).
 */
import Link from "next/link";

/** Small uppercase kicker. Rationed: a handful across the whole page. */
export function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  lede,
  serifClass,
}: {
  eyebrow?: string;
  title: string;
  lede?: string;
  /** Newsreader class from the layout, passed down so the font loads once. */
  serifClass?: string;
}) {
  return (
    <div className="max-w-3xl">
      {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
      <h2
        className={`${serifClass ?? ""} mt-2 text-balance text-2xl font-medium tracking-tight`}
      >
        {title}
      </h2>
      {lede && (
        <p className="mt-3 max-w-[65ch] text-sm leading-relaxed text-muted-foreground">
          {lede}
        </p>
      )}
    </div>
  );
}

/** Every demo figure on the site sits under one of these. Visible at the
 * point of display, not a footnote (spec 061 truth rules). */
export function IllustrativeLabel({ children }: { children?: React.ReactNode }) {
  return (
    <p className="text-xs font-medium uppercase tracking-wide text-warning">
      {children ?? "Illustrative example, not client data"}
    </p>
  );
}

export function ConfidenceBadge({
  level,
}: {
  level: "high" | "medium" | "low" | "unknown";
}) {
  const label = {
    high: "High confidence",
    medium: "Medium confidence",
    low: "Low confidence",
    unknown: "Unknown",
  }[level];
  return (
    <span className="inline-flex items-center rounded-sm border px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
      {label}
    </span>
  );
}

/**
 * Recommendation-share bar: absolute 0–100 scale, neutral ink for rivals,
 * destructive for the subject (the gap is the pain). Same grammar as the
 * audit page's RateBar so a prospect who later receives a real audit sees
 * a familiar instrument.
 */
export function ShareBar({
  name,
  pct,
  isSubject,
  note,
}: {
  name: string;
  pct: number;
  isSubject?: boolean;
  note?: string;
}) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span
        className={`w-32 shrink-0 truncate text-sm sm:w-40 ${
          isSubject ? "font-semibold" : "text-muted-foreground"
        }`}
      >
        {name}
      </span>
      <svg
        className="h-2 min-w-0 flex-1"
        viewBox="0 0 100 6"
        preserveAspectRatio="none"
        role="img"
        aria-label={`${name}: ${pct} percent`}
      >
        <rect width="100" height="6" rx="3" className="fill-foreground/10" />
        {pct > 0 && (
          <rect
            width={pct}
            height="6"
            rx="3"
            className={`transition-all duration-500 motion-reduce:transition-none ${
              isSubject ? "fill-destructive" : "fill-foreground/45"
            }`}
          />
        )}
      </svg>
      <span
        className={`w-10 shrink-0 text-right text-sm tabular-nums ${
          isSubject ? "font-semibold text-destructive" : "text-muted-foreground"
        }`}
      >
        {pct}%
      </span>
      {note && <span className="hidden text-xs text-muted-foreground sm:inline">{note}</span>}
    </div>
  );
}

/** Analytical data label + value, the KPI grammar of the audit interfaces. */
export function DataPoint({
  label,
  value,
  sub,
  negative,
}: {
  label: string;
  value: string;
  sub?: string;
  negative?: boolean;
}) {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p
        className={`mt-1 text-2xl font-semibold tracking-tight tabular-nums ${
          negative ? "text-destructive" : ""
        }`}
      >
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

const CTA_CLASSES = {
  primary:
    "inline-flex items-center justify-center rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
  secondary:
    "inline-flex items-center justify-center rounded-md border px-5 py-2.5 text-sm font-medium transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
} as const;

/** The site has exactly two CTA intents; the labels never vary (brief §33). */
export function CheckVisibilityCta({ compact }: { compact?: boolean }) {
  return (
    <Link
      href="/home#request"
      className={compact ? CTA_CLASSES.primary.replace("px-5 py-2.5", "px-3.5 py-2") : CTA_CLASSES.primary}
    >
      Check your AI visibility
    </Link>
  );
}

export function SampleAuditCta() {
  return (
    <Link href="/sample-audit" className={CTA_CLASSES.secondary}>
      View the sample audit
    </Link>
  );
}

/** ✓ / △ / ✕ indicator rows — symbol plus text, never color alone (a11y). */
export function SignalRow({
  state,
  children,
}: {
  state: "present" | "partial" | "missing";
  children: React.ReactNode;
}) {
  const glyph = { present: "✓", partial: "△", missing: "✕" }[state];
  const label = {
    present: "present",
    partial: "partial",
    missing: "missing",
  }[state];
  return (
    <li className="flex items-start gap-2.5 py-1 text-sm">
      <span
        aria-hidden
        className={`mt-px w-4 shrink-0 text-center font-medium ${
          state === "present" ? "text-foreground" : "text-muted-foreground"
        }`}
      >
        {glyph}
      </span>
      <span className={state === "present" ? "" : "text-muted-foreground"}>
        {children} <span className="sr-only">({label})</span>
      </span>
    </li>
  );
}

/** Page section wrapper: one container width, generous vertical rhythm. */
export function Section({
  id,
  children,
  bordered,
}: {
  id?: string;
  children: React.ReactNode;
  bordered?: boolean;
}) {
  return (
    <section id={id} className={`scroll-mt-20 ${bordered ? "border-t" : ""}`}>
      <div className="mx-auto max-w-7xl px-6 py-16 sm:py-20">{children}</div>
    </section>
  );
}
