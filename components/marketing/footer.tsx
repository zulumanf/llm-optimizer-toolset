import Link from "next/link";
import { BRAND_NAME, BRAND_DESCRIPTOR, MARKETING_PAGES } from "@/lib/marketing/constants";

export function MarketingFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto max-w-7xl px-6 py-12">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-sm">
            <p className="text-sm font-semibold tracking-tight">{BRAND_NAME}</p>
            <p className="mt-2 text-sm text-muted-foreground">{BRAND_DESCRIPTOR}</p>
          </div>
          <nav aria-label="Footer">
            <ul className="grid grid-cols-2 gap-x-8 gap-y-2 sm:text-right">
              {MARKETING_PAGES.filter((p) => p.path !== "/home").map((p) => (
                <li key={p.path}>
                  <Link
                    href={p.path}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {p.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <p className="mt-10 text-xs text-muted-foreground">
          Measurement methodology is versioned and updated as AI platforms evolve.
          Sample figures on this site are illustrative and labeled as such; we publish
          no client data. Research pages carry only counts that pass our claims
          registry, with their denominators and dates.
        </p>
      </div>
    </footer>
  );
}
