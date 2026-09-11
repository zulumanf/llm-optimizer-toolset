/**
 * Clean proof-appendix URL (spec 134): /report/<slug>/answers — same session
 * rule as the report, rendered by the existing answers page.
 */
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { readReportSession } from "@/lib/prospects/report-session";
import ReportAnswers from "@/components/audit/report-answers";

export const metadata: Metadata = {
  title: "Every answer, exactly as it came back",
  robots: { index: false, follow: false, noarchive: true, nocache: true },
  referrer: "no-referrer",
};
export const dynamic = "force-dynamic";

export default async function PrivateReportAnswersPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await readReportSession(slug);
  if (!session) notFound();
  return ReportAnswers({ auditId: session.auditId, reportSlug: session.slug, sessionId: session.id, sessionInternal: session.isInternal });
}
