import Link from "next/link";
import { VERTICAL_PACKS } from "@/lib/verticals/packs";
import { OnboardingWizard } from "@/components/onboarding/wizard";

export default function OnboardingPage() {
  return (
    <div className="mx-auto max-w-3xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Clients</Link>
        {" / "}New client
      </nav>
      <h1 className="text-2xl font-semibold">Onboard a client</h1>
      <p className="mb-6 mt-1 text-sm text-muted-foreground">
        Pick the vertical, describe the client once, and the platform
        generates the benchmark, identity record, and competitor set. Nothing
        is frozen or run automatically — you review the generated prompts
        first.
      </p>
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
    </div>
  );
}
