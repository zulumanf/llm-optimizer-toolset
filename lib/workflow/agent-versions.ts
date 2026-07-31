/**
 * The set of agent versions a graph is allowed to name (spec 018).
 *
 * `agentVersion` on a node is a reference, exactly as `handler` is. Every other
 * reference in a graph fails at publish time when it does not resolve; this one
 * used to fail nowhere at all, so a typo survived registration, ran, and only
 * showed up as an orphan bucket in the agent-performance metric.
 *
 * Two modules own agents, and both register their versions at import time:
 *   - `lib/agents/registry.ts`   — the spec-018 agent registry
 *   - `lib/automation/prompts.ts` — the automation library's versioned prompts
 *
 * A *declared* agent counts as known. Its contract is fixed and the registry
 * explicitly allows a graph to reference it before a runner exists; publishing
 * such a graph is legal, and the node will safe-stop for want of a handler
 * rather than for want of a contract.
 */
const known = new Set<string>();

export function registerAgentVersions(versions: Iterable<string>): void {
  for (const version of versions) known.add(version);
}

export function knownAgentVersions(): ReadonlySet<string> {
  return known;
}
