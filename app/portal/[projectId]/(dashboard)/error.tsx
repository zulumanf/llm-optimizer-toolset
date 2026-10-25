"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/** Portal error state (spec 154): plain words for a client, no internals. */
export default function PortalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("portal.error", { digest: error.digest });
  }, [error]);
  return (
    <div className="rounded-md border p-6" role="alert">
      <p className="font-medium">This page could not load.</p>
      <p className="mt-1 text-sm text-muted-foreground">Your data is safe — nothing is changed by a page failing to load. Try again, or let your Recommended First contact know{error.digest ? ` (reference ${error.digest})` : ""}.</p>
      <Button className="mt-4" variant="outline" onClick={reset}>Try again</Button>
    </div>
  );
}
