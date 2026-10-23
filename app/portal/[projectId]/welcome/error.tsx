"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/** Onboarding error state (spec 155): plain words, nothing technical. */
export default function WelcomeError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("portal.welcome_error", { digest: error.digest });
  }, [error]);
  return (
    <div className="mx-auto w-full max-w-xl px-5 py-14" role="alert">
      <p className="font-medium">This page could not load.</p>
      <p className="mt-1 text-sm text-muted-foreground">Anything you already confirmed is saved. Try again, or let your Recommended First contact know.</p>
      <Button className="mt-4 h-11" variant="outline" onClick={reset}>Try again</Button>
    </div>
  );
}
