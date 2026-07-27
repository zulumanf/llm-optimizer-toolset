import Link from "next/link";

export default function ProjectNotFound() {
  return (
    <div className="mx-auto max-w-7xl p-6">
      <div className="rounded-lg border border-dashed p-12 text-center">
        <p className="font-medium">Project not found.</p>
        <Link
          href="/projects"
          className="mt-2 inline-block text-sm text-muted-foreground underline hover:text-foreground"
        >
          Back to projects
        </Link>
      </div>
    </div>
  );
}
