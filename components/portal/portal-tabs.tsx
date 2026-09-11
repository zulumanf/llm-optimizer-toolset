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
    <nav className="mt-3 flex gap-4 text-sm">
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
                ? "border-b-2 border-foreground pb-1 font-medium text-foreground"
                : "pb-1 text-muted-foreground hover:text-foreground"
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
