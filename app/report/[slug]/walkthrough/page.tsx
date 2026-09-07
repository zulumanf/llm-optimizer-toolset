/**
 * Clean walkthrough URL (spec 134): /report/<slug>/walkthrough — same
 * session rule as the report, rendered by the existing walkthrough page.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readReportSession } from "@/lib/prospects/report-session";
import ReportWalkthrough from "@/components/audit/report-walkthrough";

export const metadata: Metadata = {
  title: "Pick a time",
  robots: { index: false, follow: false, noarchive: true, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default async function PrivateReportWalkthroughPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await readReportSession(slug);
  if (!session) notFound();
  return ReportWalkthrough({ auditId: session.auditId, reportSlug: session.slug });
}
