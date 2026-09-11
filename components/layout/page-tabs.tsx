"use client";

/**
 * Link tabs over sibling routes (spec 037). Same-question pages merged in
 * the sidebar keep their own URLs; this bar, rendered at the top of each
 * member page, is how an operator moves between them. Links, not state —
 * shadcn tabs hold content, these navigate.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export interface PageTab {
  href: string;
  label: string;
  /** Attention count shown on the tab (e.g. pending review). */
  count?: number;
  /** Match only the exact path — for a tab whose href is the section base
   * (otherwise it would light up on every sibling). */
  exact?: boolean;
}

export function PageTabs({
  tabs,
  trailing,
}: {
  tabs: PageTab[];
  /** Rendered after the tabs on the same border row (e.g. an escape-hatch
   * link) — kept here so consumers don't hand-roll the bar to add one. */
  trailing?: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className="mb-4 flex flex-wrap gap-1 border-b">
      {tabs.map((tab) => {
        const active = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm",
              active
                ? "border-primary font-medium text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            )}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium leading-none text-primary-foreground">
                {tab.count > 99 ? "99+" : tab.count}
              </span>
            )}
          </Link>
        );
      })}
      {trailing}
    </div>
  );
}
