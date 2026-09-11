/**
 * Clean private-report URL (spec 134): /report/<slug>. Renders the
 * prospect's current published audit for a valid report session of THAT
 * prospect; every other request — no cookie, another report's cookie,
 * revoked, expired — gets the private-report state (404) and no content.
 * The page itself is the one existing audit renderer.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readReportSession } from "@/lib/prospects/report-session";
import ReportDocument from "@/components/audit/report-document";

export const metadata: Metadata = {
  title: "Private AI Recommendation Report",
  robots: { index: false, follow: false, noarchive: true, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default async function PrivateReportPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await readReportSession(slug);
  if (!session) notFound();
  return ReportDocument({ auditId: session.auditId, reportSlug: session.slug, sessionId: session.id, sessionInternal: session.isInternal });
}
