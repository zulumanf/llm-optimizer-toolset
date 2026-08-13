"use client";

import { usePathname } from "next/navigation";
import { isMarketingPath } from "@/lib/marketing/constants";

/**
 * One shell, two worlds (spec 048 CRO reassessment): /audit/* is a document
 * a stranger reads — it gets NO workspace chrome, for staff too. An operator
 * previewing the page must see exactly what the prospect sees, and a
 * screenshot must never carry internal client names. The marketing site
 * (spec 061) is the same world: public pages carry their own chrome.
 * Everywhere else keeps the sidebar + assistant frame.
 */
export function AppShell({
  sidebar,
  assistant,
  children,
}: {
  sidebar: React.ReactNode;
  assistant: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  if (pathname.startsWith("/audit") || isMarketingPath(pathname)) {
    return <main className="min-h-dvh">{children}</main>;
  }
  return (
    <div className="flex h-dvh">
      {sidebar}
      {/* The assistant bar lives in the flow below main (ChatGPT-style):
          always visible, and page content can never hide behind it. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <main className="flex-1 overflow-y-auto">{children}</main>
        {assistant}
      </div>
    </div>
  );
}
