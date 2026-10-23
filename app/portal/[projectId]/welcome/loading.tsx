import { Skeleton } from "@/components/ui/skeleton";

/** Onboarding loading state (spec 155): the shape of the screen. */
export default function WelcomeLoading() {
  return (
    <div className="mx-auto w-full max-w-xl space-y-4 px-5 py-14" role="status" aria-live="polite">
      <span className="sr-only">Loading your workspace…</span>
      <Skeleton className="h-4 w-40" />
      <Skeleton className="h-8 w-72" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-56 w-full" />
    </div>
  );
}
