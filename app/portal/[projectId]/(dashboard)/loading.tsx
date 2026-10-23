import { Skeleton } from "@/components/ui/skeleton";

/** Portal loading state (spec 154): the shape of the page, with a label for screen readers. */
export default function PortalLoading() {
  return (
    <div className="space-y-4" role="status" aria-live="polite">
      <span className="sr-only">Loading your program…</span>
      <Skeleton className="h-4 w-64" />
      <Skeleton className="h-6 w-full max-w-80" />
      <Skeleton className="h-24 w-full" />
      <div className="grid gap-4 md:grid-cols-2">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}
