/**
 * Branded audit link (spec 076): /audit/<slug>/<key>. The slug is the
 * prospect's name — cosmetic; the 16-char key is the credential, resolved
 * to the prospect's current published audit's token, then rendered by the
 * one existing audit page (same snapshot path, same view logging, same
 * 404-indistinguishability). A valid key under a stale slug is redirected
 * to the canonical slug so a renamed team never strands an emailed link.
 */
import { notFound, permanentRedirect } from "next/navigation";
import { resolveAuditLink } from "@/lib/prospects/links";
import AuditTokenPage from "@/app/audit/[handle]/page";

export { metadata } from "@/app/audit/[handle]/page";
export const dynamic = "force-dynamic";

export default async function BrandedAuditPage({
  params,
}: {
  params: Promise<{ handle: string; key: string }>;
}) {
  const { handle: slug, key } = await params;
  const resolved = await resolveAuditLink(key);
  if (!resolved) notFound();
  if (slug !== resolved.canonicalSlug) {
    permanentRedirect(`/audit/${resolved.canonicalSlug}/${key}`);
  }
  return AuditTokenPage({ params: Promise.resolve({ handle: resolved.token, linkKey: key, slug: resolved.canonicalSlug }) });
}
