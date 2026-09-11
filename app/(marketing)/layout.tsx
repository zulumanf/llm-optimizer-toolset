/**
 * Marketing site layout (spec 061). The public, indexable surface: its own
 * chrome (nav + footer), its own metadata. The root AppShell already steps
 * aside for marketing paths, so this layout owns the whole frame.
 */
import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";
import { BRAND_NAME } from "@/lib/marketing/constants";

export const metadata: Metadata = {
  title: `AI Recommendation Intelligence for Real Estate | ${BRAND_NAME}`,
  description:
    "Measure how AI systems recommend your real estate brand, identify competitive visibility gaps, and improve the signals shaping your representation across AI-driven discovery.",
  robots: { index: true, follow: true },
};

export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col">
      <MarketingNav />
      <div className="flex-1">{children}</div>
      <MarketingFooter />
    </div>
  );
}
