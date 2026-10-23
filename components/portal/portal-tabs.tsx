"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** Portal nav with an honest "you are here" (spec 085): active tab carries
 * the underline and aria-current; everything else stays quiet. */
export function PortalTabs({
  tabs,
}: {
  tabs: Array<{ href: string; label: string }>;
}) {
  const pathname = usePathname();
  return (
    <nav aria-label="Program sections" className="-mx-4 mt-3 flex gap-x-5 overflow-x-auto px-4 py-1 text-sm sm:mx-0 sm:px-1">
      {tabs.map((tab) => {
        const active =
          pathname === tab.href ||
          (tab.label !== "Overview" && pathname.startsWith(tab.href));
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? "page" : undefined}
            className={
              active
                ? "shrink-0 whitespace-nowrap border-b-2 border-foreground pb-1 font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                : "shrink-0 whitespace-nowrap pb-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
