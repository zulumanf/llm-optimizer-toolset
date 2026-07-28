import { Skeleton } from "@/components/ui/skeleton";

/** Shared loading boundary for every client-workspace page. */
export default function ProjectSectionLoading() {
  return (
    <div className="mx-auto max-w-7xl p-6">
      <Skeleton className="mb-3 h-4 w-56" />
      <div className="mb-6 flex items-center justify-between">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-9 w-32" />
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <div className="space-y-2 rounded-lg border p-4">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}
