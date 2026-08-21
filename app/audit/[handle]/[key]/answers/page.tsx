/**
 * Branded route for the proof appendix (spec 076) — same resolution as the
 * branded audit page, rendered by the existing answers page.
 */
import { notFound, permanentRedirect } from "next/navigation";
import { resolveAuditLink } from "@/lib/prospects/links";
import AuditAnswersPage from "@/app/audit/[handle]/answers/page";

export { metadata } from "@/app/audit/[handle]/answers/page";
export const dynamic = "force-dynamic";

export default async function BrandedAuditAnswersPage({
  params,
}: {
  params: Promise<{ handle: string; key: string }>;
}) {
  const { handle: slug, key } = await params;
  const resolved = await resolveAuditLink(key);
  if (!resolved) notFound();
  if (slug !== resolved.canonicalSlug) {
    permanentRedirect(`/audit/${resolved.canonicalSlug}/${key}/answers`);
  }
  return AuditAnswersPage({ params: Promise.resolve({ handle: resolved.token, linkKey: key }) });
}
