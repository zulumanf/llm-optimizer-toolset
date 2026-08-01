import Link from "next/link";
import { AGENTS } from "@/lib/agents/registry";
import { agentMetrics } from "@/lib/automation/metrics";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

const DOMAIN_LABEL: Record<string, string> = {
  visibility: "1 · AI Visibility",
  reputation: "2 · Reputation Accuracy",
  authority: "3 · Authority Execution",
  revenue: "4 · AI-to-Revenue",
  advisory: "5 · Executive Advisory",
  platform: "Platform",
};

export default async function AgentRegistryPage() {
  const byDomain = new Map<string, typeof AGENTS>();
  for (const agent of AGENTS) {
    byDomain.set(agent.domain, [...(byDomain.get(agent.domain) ?? []), agent]);
  }
  const implemented = AGENTS.filter((a) => a.status === "implemented").length;
  const measured = await agentMetrics();

  return (
    <div className="mx-auto max-w-6xl p-6">
      <div className="mb-1 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Agent registry</h1>
        <Link
          href="/workflows"
          className="text-sm text-muted-foreground underline hover:text-foreground"
        >
          Workflows
        </Link>
      </div>
      <p className="mb-6 text-sm text-muted-foreground">
        {implemented} of {AGENTS.length} agents have a runner today. The rest
        have a fixed contract — schemas, scopes, prohibitions — but no
        implementation, and are labelled <em>declared</em> rather than counted as
        working.
      </p>

      {/* Measured behavior next to the declared contracts — agentMetrics()
          was computed and rendered nowhere (C5). This page previously showed
          only the hand-written registry constant. */}
      <section className="mb-8">
        <h2 className="mb-2 text-lg font-medium">Measured (workflow node runs)</h2>
        {measured.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No agent has executed inside a workflow yet — this table populates
            from real node runs, not from the registry&apos;s claims.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs">
                <tr>
                  <th className="p-2">Agent version</th>
                  <th className="p-2 text-right">Invocations</th>
                  <th className="p-2 text-right">Schema failures</th>
                  <th className="p-2 text-right">Avg confidence</th>
                  <th className="p-2 text-right">Below threshold</th>
                  <th className="p-2 text-right">Human overrides</th>
                  <th className="p-2 text-right">Avg cost</th>
                  <th className="p-2 text-right">Avg latency</th>
                </tr>
              </thead>
              <tbody>
                {measured.map((m) => (
                  <tr key={m.agentVersion} className="border-t">
                    <td className="p-2 font-mono text-xs">{m.agentVersion}</td>
                    <td className="p-2 text-right tabular-nums">{m.invocations}</td>
                    <td className="p-2 text-right tabular-nums">
                      {m.schemaFailures > 0 ? (
                        <span className="text-destructive">{m.schemaFailures}</span>
                      ) : (
                        0
                      )}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {m.avgConfidence === null ? "—" : m.avgConfidence.toFixed(2)}
                    </td>
                    <td className="p-2 text-right tabular-nums">{m.belowThreshold}</td>
                    <td className="p-2 text-right tabular-nums">{m.humanOverrides}</td>
                    <td className="p-2 text-right tabular-nums">
                      ${(m.avgCostMicroUsd / 1_000_000).toFixed(4)}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {m.avgLatencySeconds === null ? "—" : `${m.avgLatencySeconds}s`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {[...byDomain.entries()].map(([domain, agents]) => (
        <section key={domain} className="mb-8">
          <h2 className="mb-2 text-lg font-medium">{DOMAIN_LABEL[domain] ?? domain}</h2>
          <div className="space-y-2">
            {agents.map((agent) => (
              <div key={agent.key} className="rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{agent.name}</span>
                  <Badge variant={agent.status === "implemented" ? "default" : "outline"}>
                    {agent.status}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">
                    {agent.version} · {agent.model}
                  </span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">{agent.mission}</p>
                {agent.module && (
                  <p className="mt-1 font-mono text-xs text-muted-foreground">{agent.module}</p>
                )}
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    Contract
                  </summary>
                  <dl className="mt-1 space-y-1 text-xs text-muted-foreground">
                    <div>
                      <dt className="inline font-medium">May see: </dt>
                      <dd className="inline">{agent.allowedDataScopes.join(", ") || "—"}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium">Must never: </dt>
                      <dd className="inline">{agent.prohibitedActions.join("; ")}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium">Requires evidence: </dt>
                      <dd className="inline">{agent.evidenceRequirements.join("; ")}</dd>
                    </div>
                    <div>
                      <dt className="inline font-medium">Escalates when: </dt>
                      <dd className="inline">{agent.escalationConditions.join("; ")}</dd>
                    </div>
                    {agent.maxCostMicroUsd && (
                      <div>
                        <dt className="inline font-medium">Cost cap: </dt>
                        <dd className="inline">
                          ${(agent.maxCostMicroUsd / 1_000_000).toFixed(2)}
                        </dd>
                      </div>
                    )}
                  </dl>
                </details>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
