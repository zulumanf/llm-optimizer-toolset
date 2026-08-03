import Link from "next/link";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { listAllModels, mockProviderAllowed } from "@/lib/ai/registry";
import { getEnv } from "@/lib/env";
import type { ProviderId } from "@/lib/ai/types";
import { NewRunForm, type VersionOption } from "@/components/runs/new-run-form";

/** Providers whose API keys are configured — these default to enabled in the
 * form so runs don't start with cells doomed to auth failures. No key and no
 * explicit mock opt-in means no run: a fabricated answer scored as a
 * measurement is worse than a blocked form. */
function configuredProviders(): ProviderId[] {
  const env = getEnv();
  const configured: ProviderId[] = [];
  if (env.ANTHROPIC_API_KEY) configured.push("anthropic");
  if (env.OPENAI_API_KEY) configured.push("openai");
  if (process.env.GOOGLE_API_KEY) configured.push("google");
  if (process.env.PERPLEXITY_API_KEY) configured.push("perplexity");
  if (configured.length === 0 && mockProviderAllowed()) configured.push("mock");
  return configured;
}

export default async function NewRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project || project.status !== "active") notFound();

  const versions = await sql<VersionOption[]>`
    select v.id, s.name as set_name, v.version,
      jsonb_array_length(v.frozen_prompts)::int as prompt_count
    from prompt_set_versions v
    join prompt_sets s on s.id = v.prompt_set_id
    where s.project_id = ${id}
    order by s.name asc, v.version desc
  `;

  return (
    <div className="mx-auto max-w-3xl p-6">
      <nav className="mb-3 text-sm text-muted-foreground">
        <Link href="/projects" className="hover:text-foreground">Projects</Link>
        {" / "}
        <Link href={`/projects/${id}`} className="hover:text-foreground">
          {project.name}
        </Link>
        {" / "}
        <Link href={`/projects/${id}/runs`} className="hover:text-foreground">
          Runs
        </Link>
        {" / "}New
      </nav>
      <h1 className="mb-4 text-2xl font-semibold">New run</h1>

      {configuredProviders().length === 0 ? (
        <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-10 text-center text-sm">
          <p className="font-medium text-destructive">
            No AI provider is configured.
          </p>
          <p className="mt-2 text-muted-foreground">
            Runs need at least one real provider API key
            (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY or
            PERPLEXITY_API_KEY) in the environment. The mock provider is not
            offered as a fallback — its fabricated answers would be scored as
            real measurements.
          </p>
        </div>
      ) : versions.length === 0 ? (
        <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
          No frozen prompt-set versions in this project yet. Runs only execute
          frozen versions —{" "}
          <Link href={`/projects/${id}/prompts`} className="underline">
            freeze a set first
          </Link>
          .
        </div>
      ) : (
        <NewRunForm
          projectId={id}
          versions={versions}
          models={listAllModels()}
          defaultEnabled={configuredProviders()}
        />
      )}
    </div>
  );
}
