/**
 * Marketing site layout (spec 061). The public, indexable surface: its own
 * chrome (nav + footer), its own metadata. The root AppShell already steps
 * aside for marketing paths, so this layout owns the whole frame.
 */
import type { Metadata } from "next";
import { MarketingNav } from "@/components/marketing/nav";
import { MarketingFooter } from "@/components/marketing/footer";
import { BRAND_NAME, BRAND_DESCRIPTOR, marketingOrigin } from "@/lib/marketing/constants";
import { JsonLd } from "@/components/marketing/json-ld";
import { organizationLd, websiteLd } from "@/lib/marketing/seo";

export const metadata: Metadata = {
  metadataBase: new URL(marketingOrigin()),
  title: {
    default: `AI Recommendation Intelligence for Real Estate | ${BRAND_NAME}`,
    template: `%s | ${BRAND_NAME}`,
  },
  description: BRAND_DESCRIPTOR,
  robots: { index: true, follow: true },
  openGraph: { siteName: BRAND_NAME, type: "website", locale: "en_US" },
};

export default function MarketingLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col">
      <JsonLd data={[organizationLd(), websiteLd()]} />
      <MarketingNav />
      <div className="flex-1">{children}</div>
      <MarketingFooter />
    </div>
  );
}
