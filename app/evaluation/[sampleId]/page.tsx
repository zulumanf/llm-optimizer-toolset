import { notFound } from "next/navigation";
import { EmptyState, PageHeader, PageShell, Section } from "@/components/layout/page";
import { AnnotationForm } from "@/components/evaluation/annotation-form";
import { GoldReportView } from "@/components/evaluation/gold-report";
import { goldReport, listGoldSamples, nextItemForAnnotator } from "@/lib/evaluation/gold";
import { requireStaffPage } from "@/lib/security/page-gates";

export default async function GoldSamplePage({ params }: { params: Promise<{ sampleId: string }> }) {
  const user = await requireStaffPage();
  const { sampleId } = await params;
  const sample = (await listGoldSamples()).find((s) => s.id === sampleId);
  if (!sample) notFound();
  const [item, report] = await Promise.all([nextItemForAnnotator(sampleId, user.id), goldReport(sampleId)]);

  return (
    <PageShell>
      <PageHeader
        crumbs={[{ label: "Classifier check", href: "/evaluation" }, { label: sample.name }]}
        title={sample.name}
        description="Read the answer and decide how it treats the named company. The classifier's decision is hidden on purpose."
      />
      <Section title="Results so far">
        <GoldReportView report={report} />
      </Section>
      <Section title="Label the next pair">
        {item ? (
          <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
            <div className="grid gap-2">
              <p className="text-xs text-muted-foreground tabular-nums">
                {item.remaining} left for you · {item.provider}
              </p>
              <p className="text-sm">
                <span className="font-medium">Company:</span> {item.companyName}
                {item.companyAliases.length > 0 && <span className="text-muted-foreground"> (also: {item.companyAliases.join(", ")})</span>}
              </p>
              <p className="text-sm">
                <span className="font-medium">Question asked:</span> {item.promptText}
              </p>
              <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm">{item.responseText}</pre>
            </div>
            <AnnotationForm key={item.itemId} itemId={item.itemId} />
          </div>
        ) : (
          <EmptyState message="You have labelled every pair in this sample. Ask a second person to label it too; disagreements then need a decision." />
        )}
      </Section>
    </PageShell>
  );
}
