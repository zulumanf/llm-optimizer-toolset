"use client";

import { useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Root error boundary. Before this, a thrown error anywhere outside
 * /projects dropped the operator on Next's raw error screen — unacceptable
 * once a page can be seen by anyone but the developer.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Server errors are already structured-logged; this captures the client
    // side of the same failure so the two can be correlated by digest.
    console.error("app.error", { message: error.message, digest: error.digest });
  }, [error]);

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="rounded-lg border border-destructive/40 p-8">
        <p className="font-medium">Something went wrong on this page.</p>
        <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
        {error.digest && (
          <p className="mt-1 font-mono text-xs text-muted-foreground">
            error id {error.digest}
          </p>
        )}
        <p className="mt-4 text-sm text-muted-foreground">
          Nothing was lost — measurements, evidence, and classifications are
          insert-only, so a failed page render never changes stored data.
        </p>
        <div className="mt-4 flex gap-2">
          <Button variant="outline" onClick={reset}>
            Retry
          </Button>
          <Link href="/">
            <Button variant="ghost">Back to Today</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
