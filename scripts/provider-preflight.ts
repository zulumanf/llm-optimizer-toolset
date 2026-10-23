/**
 * Benchmark provider preflight (2026-09-14): the cheapest reliable check of
 * whether a benchmark run could execute — never a full benchmark call.
 * Each provider gets one 1-token completion; an exhausted quota is refused
 * before any spend. The verdict is cached in
 * .local-data/supply/provider-status.json for PREFLIGHT_TTL_MINUTES so a
 * blocked provider is not hammered. Never changes billing.
 *
 * Fails closed: AVAILABLE only on an authenticated 2xx. A missing key, any
 * non-2xx (401/403/402/429/5xx…) or a network fault is NOT available. (The
 * run-start billing probe in lib/ai/openai.ts is deliberately lenient about
 * transient faults; it is not used here, because a preflight that says
 * "available" without proof is worse than no preflight.)
 *
 * Run: npx tsx scripts/provider-preflight.ts [--force]
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { OPENAI_PROBE_MODEL } from "@/lib/ai/openai";
import { classifyProviderError, PROVIDER_OPERATOR_ACTIONS as ACTIONS, type ProviderState, type ProviderStatus } from "@/lib/ai/provider-state";

export { classifyProviderError };
export type { ProviderState, ProviderStatus };

export const PREFLIGHT_TTL_MINUTES = 30;
const STATUS_FILE = ".local-data/supply/provider-status.json";
const REASON_MAX_CHARS = 300;
const HTTP_FORBIDDEN = 403;
const HTTP_BAD_REQUEST = 400;
const OUTPUT_LIMIT_REACHED = /max_tokens or model output limit was reached/i;

export interface ProbeDeps {
  env: Record<string, string | undefined>;
  fetch: typeof fetch;
  now: () => Date;
}

const defaultDeps = (): ProbeDeps => ({ env: process.env, fetch: globalThis.fetch, now: () => new Date() });

/** Preflight-only state for a non-2xx answer: 403 is a credential/permission
 * refusal (the shared classifier would call it retryable). Everything else
 * uses the shared classification — none of it is AVAILABLE. */
export function preflightStateFor(status: number, message: string): ProviderState {
  if (status === HTTP_FORBIDDEN) return "AUTH_ERROR";
  const state = classifyProviderError({ status, message });
  return state === "AVAILABLE" ? "RETRYABLE_ERROR" : state;
}

/** One 1-token completion against an OpenAI-compatible endpoint. */
async function probeCompletion(
  provider: string,
  keyName: string,
  url: string,
  body: Record<string, unknown>,
  deps: ProbeDeps
): Promise<ProviderStatus> {
  const at = deps.now().toISOString();
  const status = (state: ProviderState, reason: string | null): ProviderStatus => ({
    provider, state, reason, observedAt: at, operatorAction: ACTIONS[state],
  });
  const key = deps.env[keyName];
  if (!key) return status("AUTH_ERROR", `${keyName} not set`);
  try {
    const res = await deps.fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) return status("AVAILABLE", null);
    const text = (await res.text()).slice(0, REASON_MAX_CHARS);
    // A reasoning model can spend the 1-token probe budget before emitting
    // output. That refusal comes after auth and billing were accepted, so it
    // proves availability; nothing else in the 4xx range does.
    if (res.status === HTTP_BAD_REQUEST && OUTPUT_LIMIT_REACHED.test(text)) {
      return status("AVAILABLE", "authenticated; probe stopped at its 1-token output cap");
    }
    return status(preflightStateFor(res.status, text), `HTTP ${res.status}: ${text}`);
  } catch (e) {
    return status("RETRYABLE_ERROR", (e as Error).message);
  }
}

export function probePerplexity(deps: ProbeDeps = defaultDeps()): Promise<ProviderStatus> {
  return probeCompletion("perplexity", "PERPLEXITY_API_KEY", "https://api.perplexity.ai/chat/completions",
    { model: "sonar", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }, deps);
}

export function probeOpenAI(deps: ProbeDeps = defaultDeps()): Promise<ProviderStatus> {
  return probeCompletion("openai", "OPENAI_API_KEY", "https://api.openai.com/v1/chat/completions",
    { model: OPENAI_PROBE_MODEL, max_completion_tokens: 1, messages: [{ role: "user", content: "ok" }] }, deps);
}

export function readCachedStatus(now = new Date()): ProviderStatus[] | null {
  if (!existsSync(STATUS_FILE)) return null;
  const rows = JSON.parse(readFileSync(STATUS_FILE, "utf8")) as ProviderStatus[];
  const fresh = rows.every((r) => now.getTime() - new Date(r.observedAt).getTime() < PREFLIGHT_TTL_MINUTES * 60_000);
  return fresh ? rows : null;
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const cached = force ? null : readCachedStatus();
  const rows = cached ?? [await probeOpenAI(), await probePerplexity()];
  if (!cached) { mkdirSync(".local-data/supply", { recursive: true }); writeFileSync(STATUS_FILE, JSON.stringify(rows, null, 1)); }
  for (const r of rows) console.log(`${r.provider}: ${r.state}${r.reason ? ` — ${r.reason.slice(0, 160)}` : ""}${r.operatorAction ? ` → ${r.operatorAction}` : ""}${cached ? " (cached)" : ""}`);
  const benchmarkable = rows.find((r) => r.provider === "openai")?.state === "AVAILABLE";
  console.log(`BENCHMARK_PROVIDER: ${benchmarkable ? "AVAILABLE" : "PROVIDER_CAPACITY_BLOCKED"}`);
}

if (process.argv[1]?.endsWith("provider-preflight.ts")) main().catch((e) => { console.error(e); process.exit(1); });
