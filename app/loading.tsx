import { Skeleton } from "@/components/ui/skeleton";

/** Root loading boundary — covers Today, Inbox, Companies, and Onboarding
 * (nested segments with their own loading.tsx still win). */
export default function RootLoading() {
  return (
    <div className="mx-auto max-w-6xl p-6">
      <Skeleton className="mb-2 h-8 w-48" />
      <Skeleton className="mb-6 h-4 w-96" />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <div className="space-y-2 rounded-lg border p-4">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    </div>
  );
}
