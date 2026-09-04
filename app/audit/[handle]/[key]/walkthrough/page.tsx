/**
 * Branded walkthrough route: /audit/<slug>/<key>/walkthrough — resolves the
 * link like the branded report and answers pages, then renders the same
 * page under the report's token.
 */
import { notFound, permanentRedirect } from "next/navigation";
import { resolveAuditLink } from "@/lib/prospects/links";
import WalkthroughPage from "@/app/audit/[handle]/walkthrough/page";

export { metadata } from "@/app/audit/[handle]/walkthrough/page";
export const dynamic = "force-dynamic";

export default async function BrandedWalkthroughPage({
  params,
}: {
  params: Promise<{ handle: string; key: string }>;
}) {
  const { handle: slug, key } = await params;
  const resolved = await resolveAuditLink(key);
  if (!resolved) notFound();
  if (slug !== resolved.canonicalSlug) {
    permanentRedirect(`/audit/${resolved.canonicalSlug}/${key}/walkthrough`);
  }
  return WalkthroughPage({ params: Promise.resolve({ handle: resolved.token, linkKey: key, slug }) });
}
