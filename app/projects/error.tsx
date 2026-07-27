"use client";

import { Button } from "@/components/ui/button";

export default function ProjectsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="rounded-lg border border-destructive/40 p-8 text-center">
        <p className="font-medium">Projects failed to load.</p>
        <p className="mt-1 text-sm text-muted-foreground">
          {error.message}
          {error.digest ? ` · error id ${error.digest}` : null}
        </p>
        <Button className="mt-4" variant="outline" onClick={reset}>
          Retry
        </Button>
      </div>
    </div>
  );
}
