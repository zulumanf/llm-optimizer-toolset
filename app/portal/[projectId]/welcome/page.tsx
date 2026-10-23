import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { portalOnboarding } from "@/lib/engagements/client-onboarding";
import { OnboardingFlow } from "@/components/portal/onboarding-flow";

export const dynamic = "force-dynamic";

/** Required onboarding (spec 155): no dashboard navigation, one column.
 * Nothing to confirm (not prepared / not ready) → the dashboard. */
export default async function PortalWelcomePage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  const view = await portalOnboarding(await getCurrentUser(), projectId);
  if (!view) redirect(`/portal/${projectId}`);
  return <OnboardingFlow projectId={projectId} view={view} />;
}
