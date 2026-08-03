import { getCurrentUserOrNull, isStaff } from "@/lib/auth";
import { AssistantDock } from "@/components/assistant/assistant-dock";

/**
 * Renders the assistant dock only for a staff session — the sidebar's rule
 * (components/layout/sidebar.tsx): nothing on /login, the public audit
 * pages, or the client portal. Rendering decision, not the security
 * boundary; the assistant service re-asserts staff on every call.
 */
export async function AssistantGate(): Promise<React.ReactElement | null> {
  const user = await getCurrentUserOrNull();
  if (!user || !isStaff(user)) return null;
  return <AssistantDock />;
}
