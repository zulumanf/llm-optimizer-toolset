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
}

export function PageTabs({ tabs }: { tabs: PageTab[] }) {
  const pathname = usePathname();
  return (
    <div className="mb-4 flex gap-1 border-b">
      {tabs.map((tab) => {
        const active =
          pathname === tab.href || pathname.startsWith(`${tab.href}/`);
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
    </div>
  );
}
