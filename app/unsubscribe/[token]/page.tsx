/**
 * Unsubscribe confirmation (spec 157). Prospect-facing and public. It never
 * reveals the address or whether the token is valid; the form posts to the
 * one-click endpoint, which answers every token identically.
 */
import { OUTREACH_PUBLIC_WEBSITE } from "@/lib/prospects/constants";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Unsubscribe — Recommended First",
  robots: { index: false, follow: false },
};

export default async function UnsubscribePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ done?: string }>;
}) {
  const { token } = await params;
  const { done } = await searchParams;
  const isDone = done === "1";

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-6 py-16">
      <div className="w-full max-w-md space-y-6 rounded-lg border p-8">
        {isDone ? (
          <>
            <h1 className="text-2xl font-semibold text-balance">You are unsubscribed</h1>
            <p className="text-sm text-muted-foreground">
              We will not email this address again. If that was a mistake, reply to any of our
              emails and we will take it from there.
            </p>
          </>
        ) : (
          <>
            <h1 className="text-2xl font-semibold text-balance">Stop emails from Recommended First</h1>
            <p className="text-sm text-muted-foreground">
              Confirm below and we will not email this address again.
            </p>
            <form method="post" action={`/api/unsubscribe/${encodeURIComponent(token)}`}>
              <input type="hidden" name="confirm" value="1" />
              <button
                type="submit"
                className="w-full rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              >
                Unsubscribe
              </button>
            </form>
          </>
        )}
        <p className="text-xs text-muted-foreground">Recommended First · {OUTREACH_PUBLIC_WEBSITE}</p>
      </div>
    </main>
  );
}
