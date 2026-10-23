import Link from "next/link";
import { EmptyState, PageHeader, PageShell, Section } from "@/components/layout/page";
import { CreateSampleForm } from "@/components/evaluation/create-sample-form";
import { listGoldSamples } from "@/lib/evaluation/gold";
import { requireStaffPage } from "@/lib/security/page-gates";

export default async function EvaluationPage() {
  await requireStaffPage();
  const samples = await listGoldSamples();
  return (
    <PageShell>
      <PageHeader
        title="Classifier check"
        description="Label real AI answers by hand, without seeing what the classifier decided, to measure how often its “recommended” and “mentioned” calls are right."
      />
      <Section title="Draw a new sample" description="A seeded, balanced draw of real answers across providers and classifier outcomes. Two people should label each pair.">
        <CreateSampleForm />
      </Section>
      <Section title="Samples">
        {samples.length === 0 ? (
          <EmptyState message="No samples yet. Draw one above, then label pairs; precision and recall appear once two people agree on a pair." />
        ) : (
          <ul className="grid gap-2">
            {samples.map((s) => (
              <li key={s.id} className="rounded-md border p-3 text-sm">
                <Link href={`/evaluation/${s.id}`} className="font-medium underline-offset-4 hover:underline">
                  {s.name}
                </Link>
                <span className="ml-2 text-xs text-muted-foreground tabular-nums">
                  {s.items} pairs · {s.createdAt.toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </PageShell>
  );
}
