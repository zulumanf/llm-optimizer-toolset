/**
 * Benchmark provider preflight (2026-09-14): the cheapest reliable check of
 * whether a benchmark run could execute — never a full benchmark call.
 * OpenAI: the existing 1-token quota probe (billing refusals fail it,
 * transient faults do not). Perplexity: a 1-token `sonar` call; an
 * exhausted quota is refused before any spend. The verdict is cached in
 * .local-data/supply/provider-status.json for PREFLIGHT_TTL_MINUTES so a
 * blocked provider is not hammered. Never changes billing.
 *
 * Run: npx tsx scripts/provider-preflight.ts [--force]
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { probeOpenAIQuota } from "@/lib/ai/openai";
import { classifyProviderError, PROVIDER_OPERATOR_ACTIONS as ACTIONS, type ProviderState, type ProviderStatus } from "@/lib/ai/provider-state";

export { classifyProviderError };
export type { ProviderState, ProviderStatus };

export const PREFLIGHT_TTL_MINUTES = 30;
const STATUS_FILE = ".local-data/supply/provider-status.json";


/** Pure: map a provider error to the provider-agnostic state. */


async function probePerplexity(): Promise<ProviderStatus> {
  const key = process.env.PERPLEXITY_API_KEY;
  const at = new Date().toISOString();
  if (!key) return { provider: "perplexity", state: "AUTH_ERROR", reason: "PERPLEXITY_API_KEY not set", observedAt: at, operatorAction: ACTIONS.AUTH_ERROR };
  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "sonar", max_tokens: 1, messages: [{ role: "user", content: "ok" }] }),
    });
    if (res.ok) return { provider: "perplexity", state: "AVAILABLE", reason: null, observedAt: at, operatorAction: null };
    const text = (await res.text()).slice(0, 300);
    const state = classifyProviderError({ status: res.status, message: text });
    return { provider: "perplexity", state, reason: `HTTP ${res.status}: ${text}`, observedAt: at, operatorAction: ACTIONS[state] };
  } catch (e) {
    return { provider: "perplexity", state: "RETRYABLE_ERROR", reason: (e as Error).message, observedAt: at, operatorAction: ACTIONS.RETRYABLE_ERROR };
  }
}

async function probeOpenAI(): Promise<ProviderStatus> {
  const at = new Date().toISOString();
  const r = await probeOpenAIQuota();
  if (r.ok) return { provider: "openai", state: "AVAILABLE", reason: null, observedAt: at, operatorAction: null };
  const state = classifyProviderError({ status: 429, message: r.reason });
  return { provider: "openai", state, reason: r.reason ?? null, observedAt: at, operatorAction: ACTIONS[state] };
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
