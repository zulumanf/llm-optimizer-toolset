import { PageHeader, PageShell } from "@/components/layout/page";
import { VERTICAL_PACKS } from "@/lib/verticals/packs";
import { OnboardingWizard } from "@/components/onboarding/wizard";

export default function OnboardingPage() {
  return (
    <PageShell>
      <PageHeader
        crumbs={[{ label: "Clients", href: "/projects" }, { label: "New client" }]}
        title="Onboard a client"
        description="Pick the vertical, describe the client once, and the platform generates the benchmark, identity record, and competitor set. Nothing is frozen or run automatically — you review the generated prompts first."
      />
      <OnboardingWizard
        packs={VERTICAL_PACKS.map((p) => ({
          key: p.key,
          name: p.name,
          description: p.description,
          version: p.version,
          variables: p.variables,
          claimKeys: p.claimKeys,
          promptCount: p.promptTemplates.length,
          complianceCount: p.compliance.length,
        }))}
      />
    </PageShell>
  );
}
