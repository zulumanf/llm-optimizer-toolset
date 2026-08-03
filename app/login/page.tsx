import { redirect } from "next/navigation";
import { getEnv } from "@/lib/env";
import { getCurrentUserOrNull } from "@/lib/auth";
import { requestMagicLink } from "@/app/login/actions";
import { MagicLinkForm } from "@/components/auth/magic-link-form";

export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; sent?: string }>;
}) {
  const env = getEnv();

  // In dev mode there is nothing to sign into; sending an operator to a login
  // form that cannot work would be a dead end.
  if (env.AUTH_MODE !== "supabase") redirect("/");

  const existing = await getCurrentUserOrNull();
  if (existing) redirect("/");

  const params = await searchParams;

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold tracking-tight">AI Visibility OS</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Internal tool. Sign in with your work email and we&apos;ll send a one-time
          link.
        </p>

        {params.sent ? (
          <div
            role="status"
            className="mt-6 rounded-md border border-dashed p-4 text-sm"
          >
            <p className="font-medium">Check your inbox</p>
            <p className="mt-1 text-muted-foreground">
              If that address is provisioned for this workspace, a sign-in link is on
              its way. The link expires shortly and can be used once.
            </p>
          </div>
        ) : (
          <MagicLinkForm action={requestMagicLink} />
        )}

        {params.error && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {params.error === "callback"
              ? "That sign-in link is invalid or has expired. Request a new one."
              : "Something went wrong. Try again."}
          </p>
        )}
      </div>
    </main>
  );
}
