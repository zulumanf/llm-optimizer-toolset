import { Skeleton } from "@/components/ui/skeleton";

/** Portal-level loading state: shown while the portal gate resolves, so a
 * client never sees the internal workspace's skeleton. Fluid widths only —
 * it must fit a 390px phone. */
export default function PortalGateLoading() {
  return (
    <div className="mx-auto max-w-4xl space-y-4 px-4 py-6 sm:px-6 sm:py-10" role="status" aria-live="polite">
      <span className="sr-only">Loading your program…</span>
      <Skeleton className="h-3 w-32 max-w-full" />
      <Skeleton className="h-7 w-full max-w-80" />
      <Skeleton className="h-4 w-full max-w-md" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
