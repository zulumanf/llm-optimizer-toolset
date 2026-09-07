import { PageHeader, PageShell } from "@/components/layout/page";
import { notFound } from "next/navigation";
import { getProject } from "@/db/projects";
import { sql } from "@/db/client";
import { listAllModels } from "@/lib/ai/registry";
import { getEnv } from "@/lib/env";
import { listActiveStaffUsers } from "@/db/users";
import { listPortalGrants } from "@/lib/portal/invite";
import { GrantActions } from "@/components/portal/grant-actions";
import { getCurrentUser } from "@/lib/auth";
import { ClientInviteForm } from "@/components/settings/client-invite-form";
import { BaselineSettingsForm } from "@/components/settings/baseline-settings-form";
import { PortfolioFieldsForm } from "@/components/settings/portfolio-fields-form";
import type { ProviderConfig } from "@/lib/runs/cells";

export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const project = await getProject(id);
  if (!project) notFound();

  const [config] = await sql`
    select baseline_prompt_set_id, baseline_config, account_owner_id,
      service_tier, contract_value_usd
    from projects where id = ${id}
  `;
  const owners = await listActiveStaffUsers();
  const [grants, currentUser] = await Promise.all([
    listPortalGrants(id),
    getCurrentUser(),
  ]);
  const sets = await sql`
    select s.id, s.name,
      (select max(v.version) from prompt_set_versions v
        where v.prompt_set_id = s.id) as latest_version
    from prompt_sets s
    where s.project_id = ${id} and s.archived_at is null
    order by s.name asc
  `;
  const env = getEnv();
  const cronConfigured = Boolean(env.CRON_SECRET);

  return (
    <PageShell>
      <PageHeader
        crumbs={[{ label: "Projects", href: "/projects" }, { label: project.name, href: `/projects/${id}` }, { label: "Settings" }]}
        title="Settings"
        description={
          <>
        Weekly baseline: every Monday the cron runs the chosen set&rsquo;s
        latest frozen version with this configuration (docs/07 cadence).
          </>
        }
      />

      <div className="mb-6 rounded-md border p-4">
        <p className="mb-3 text-sm font-medium">Portfolio (spec 030)</p>
        <PortfolioFieldsForm
          projectId={id}
          owners={owners}
          currentOwnerId={(config?.accountOwnerId as string | null) ?? null}
          currentTier={(config?.serviceTier as string | null) ?? null}
          currentContractValue={
            config?.contractValueUsd == null ? null : Number(config.contractValueUsd)
          }
        />
      </div>

      <BaselineSettingsForm
        projectId={id}
        sets={sets.map((s) => ({
          id: s.id as string,
          name: s.name as string,
          latestVersion: (s.latestVersion as number | null) ?? null,
        }))}
        models={listAllModels()}
        current={{
          baselinePromptSetId: (config?.baselinePromptSetId as string | null) ?? null,
          providers:
            ((config?.baselineConfig as { providers?: ProviderConfig[] } | null)
              ?.providers as ProviderConfig[] | undefined) ?? null,
          budgetUsd:
            ((config?.baselineConfig as { budgetUsd?: number } | null)
              ?.budgetUsd as number | undefined) ?? null,
        }}
      />

      <div className="mt-6 rounded-md border p-4">
        <p className="mb-1 text-sm font-medium">Client portal access</p>
        <p className="mb-3 text-xs text-muted-foreground">
          Client accounts are read-only and see only this program&apos;s
          portal — never the internal workspace. Invites are admin-only.
        </p>
        {grants.length > 0 && (
          <ul className="mb-3 space-y-2 text-sm">
            {grants.map((g) => (
              <li
                key={g.userId}
                className="flex flex-wrap items-center justify-between gap-2 text-muted-foreground"
              >
                <span>
                  {g.name} · {g.email}
                  {!g.active && " · deactivated"}
                </span>
                {currentUser.role === "admin" && (
                  <GrantActions projectId={id} userId={g.userId} active={g.active} />
                )}
              </li>
            ))}
          </ul>
        )}
        {currentUser.role === "admin" ? (
          <ClientInviteForm projectId={id} />
        ) : (
          <p className="text-xs text-muted-foreground">
            Ask an admin to invite client accounts.
          </p>
        )}
      </div>

      <div className="mt-6 rounded-md border bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
        <p className="font-medium text-foreground">Cron wiring</p>
        <p className="mt-1">
          {cronConfigured
            ? "CRON_SECRET is set. Point a scheduler (e.g. cron, Vercel Cron) at:"
            : "CRON_SECRET is not set in .env — the endpoint refuses all requests until it is."}
        </p>
        <pre className="mt-2 overflow-x-auto rounded bg-muted/50 p-2 font-mono text-xs">
{`curl -X POST http://localhost:3000/api/cron/weekly-baseline \\
  -H "Authorization: Bearer $CRON_SECRET"`}
        </pre>
      </div>
    </PageShell>
  );
}
