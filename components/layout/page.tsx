/**
 * Page primitives (docs/04).
 *
 * `docs/04-ui-design-system.md` has always specified one content width, one
 * type scale and a mandatory empty state. What it lacked was anything to
 * *import* — so 35 of 52 pages hand-rolled the same breadcrumb-and-title
 * block, and six different container widths drifted into the app. A design
 * system nobody can import is a style guide, and style guides lose.
 *
 * These are the components that make the documented rules the path of least
 * resistance. `tests/unit/layout-consistency.test.ts` fails the build when a
 * page reintroduces a bespoke shell.
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The page container. One width for every page: differing widths make two
 * pages in the same feature feel like two products, which is exactly the
 * complaint this exists to answer.
 */
export function PageShell({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("mx-auto max-w-7xl p-6", className)}>{children}</div>;
}

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Breadcrumb + title + description + actions, in one place.
 *
 * `description` is deliberately not optional-by-omission in spirit: an
 * operator landing on a dense internal page should be told what they are
 * looking at. Pass it.
 */
export function PageHeader({
  title,
  description,
  crumbs = [],
  badge,
  actions,
}: {
  title: string;
  description?: ReactNode;
  crumbs?: Crumb[];
  badge?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-6">
      {crumbs.length > 0 && (
        <nav aria-label="Breadcrumb" className="mb-3 text-sm text-muted-foreground">
          {crumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`}>
              {index > 0 && <span aria-hidden="true"> / </span>}
              {crumb.href ? (
                <Link href={crumb.href} className="hover:text-foreground">
                  {crumb.label}
                </Link>
              ) : (
                <span>{crumb.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            {badge}
          </div>
          {description && (
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}

/** A titled block. `text-lg` per the scale — no page invents its own heading size. */
export function Section({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mt-8 first:mt-0", className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            {title && <h2 className="text-lg font-medium">{title}</h2>}
            {description && (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/**
 * The mandatory empty state (docs/04): one sentence explaining the emptiness,
 * and an action where one exists. Never a bare "no data".
 */
export function EmptyState({
  message,
  action,
  className,
}: {
  message: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground",
        className
      )}
    >
      <p className="mx-auto max-w-prose">{message}</p>
      {action && <div className="mt-3 flex justify-center">{action}</div>}
    </div>
  );
}

/** Metric tiles. `tabular-nums` is not optional — misaligned digits are unreadable. */
export function StatGrid({
  children,
  columns = 4,
}: {
  children: ReactNode;
  columns?: 2 | 3 | 4;
}) {
  const cols = {
    2: "sm:grid-cols-2",
    3: "sm:grid-cols-3",
    4: "sm:grid-cols-4",
  }[columns];
  return <dl className={cn("grid grid-cols-2 gap-3", cols)}>{children}</dl>;
}

export function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  /** Pass the string "not measured" rather than 0 when nothing was observed. */
  value: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="rounded-md border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-lg font-medium tabular-nums">{value}</dd>
      {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
