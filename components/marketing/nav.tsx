"use client";

/**
 * Marketing site navigation (spec 061). Sticky, one line at desktop, small
 * disclosure menu on mobile. The single client concern is the mobile toggle.
 */
import { useState } from "react";
import Link from "next/link";
import { Menu, X } from "lucide-react";
import { BRAND_NAME } from "@/lib/marketing/constants";
import { CheckVisibilityCta } from "@/components/marketing/ui";

const LINKS = [
  { href: "/methodology", label: "Methodology" },
  { href: "/research", label: "Research" },
  { href: "/citation-intelligence", label: "Citations" },
  { href: "/sample-audit", label: "Sample audit" },
  { href: "/faq", label: "FAQ" },
];

export function MarketingNav() {
  const [open, setOpen] = useState(false);
  return (
    <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-6 px-6">
        <Link
          href="/home"
          className="text-sm font-semibold tracking-tight transition-colors hover:text-muted-foreground"
        >
          {BRAND_NAME}
        </Link>
        <nav className="hidden items-center gap-6 md:flex" aria-label="Main">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {link.label}
            </Link>
          ))}
          <CheckVisibilityCta compact />
        </nav>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-md p-2 transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:hidden"
          aria-expanded={open}
          aria-controls="marketing-mobile-nav"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="size-5" /> : <Menu className="size-5" />}
          <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
        </button>
      </div>
      {open && (
        <nav
          id="marketing-mobile-nav"
          aria-label="Main"
          className="border-t px-6 pb-4 md:hidden"
        >
          <ul className="flex flex-col">
            {LINKS.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="block py-3 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
          <div onClick={() => setOpen(false)}>
            <CheckVisibilityCta />
          </div>
        </nav>
      )}
    </header>
  );
}
