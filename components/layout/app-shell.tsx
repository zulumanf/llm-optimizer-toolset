"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";

/**
 * One shell, two worlds (spec 048 CRO reassessment): /audit/* is a document
 * a stranger reads — it gets NO workspace chrome, for staff too. An operator
 * previewing the page must see exactly what the prospect sees, and a
 * screenshot must never carry internal client names. Everywhere else keeps
 * the sidebar + assistant frame.
 *
 * Responsive (spec 083): at lg+ the sidebar is the static panel it always
 * was; below lg it becomes a slide-over behind a slim top bar. Same
 * server-rendered sidebar content in both — no second nav to drift.
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
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Navigation closes the drawer — tapping a nav link should land on the
  // page, not on the page behind a drawer.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  if (pathname.startsWith("/audit")) {
    return <main className="min-h-dvh">{children}</main>;
  }
  return (
    <div className="flex h-dvh flex-col lg:flex-row">
      {/* Mobile top bar */}
      <header className="flex shrink-0 items-center gap-2 border-b bg-card px-3 py-2 lg:hidden">
        <button
          type="button"
          aria-label={drawerOpen ? "Close menu" : "Open menu"}
          aria-expanded={drawerOpen}
          className="rounded-md border p-1.5"
          onClick={() => setDrawerOpen((open) => !open)}
        >
          {drawerOpen ? (
            <X className="size-4" aria-hidden />
          ) : (
            <Menu className="size-4" aria-hidden />
          )}
        </button>
        <p className="text-sm font-semibold">AI Visibility OS</p>
      </header>

      {/* Static sidebar at lg+ */}
      <div className="hidden shrink-0 lg:flex">{sidebar}</div>

      {/* Slide-over drawer below lg */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 flex max-w-[85vw] shadow-xl">
            {sidebar}
          </div>
        </div>
      )}

      {/* The assistant bar lives in the flow below main (ChatGPT-style):
          always visible, and page content can never hide behind it. */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <main className="flex-1 overflow-y-auto">{children}</main>
        {assistant}
      </div>
    </div>
  );
}
