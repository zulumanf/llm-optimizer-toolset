/**
 * Spec 117 §3 — search_context_size A/B harness. Runs N frozen prompts from
 * a run's prompt set at default vs low retrieval depth and compares WHAT WE
 * SCORE: which tracked entities are named. Ad-hoc probe calls — results go
 * to stdout/scratch, NEVER into the responses table (not a measurement).
 * Needs live OpenAI credits.
 *   npx tsx scripts/search-context-ab.ts <runIdPrefix> [nPrompts=8]
 */
import "dotenv/config";
import OpenAI from "openai";
import { sql } from "@/db/client";
import { listCompaniesForProject } from "@/db/companies";

const MODEL = "gpt-5.4-mini-2026-03-17";

async function ask(client: OpenAI, prompt: string, size: "low" | null): Promise<{ text: string; tokensIn: number }> {
  const res = await client.responses.create({
    model: MODEL,
    tools: [{ type: "web_search", ...(size ? { search_context_size: size } : {}) }],
    input: prompt,
    service_tier: "flex",
  }, { timeout: 300_000 });
  const text = (res as { output_text?: string }).output_text ?? JSON.stringify(res);
  const tokensIn = (res as { usage?: { input_tokens?: number } }).usage?.input_tokens ?? 0;
  return { text, tokensIn };
}

const named = (text: string, names: string[]): Set<string> =>
  new Set(names.filter((n) => text.toLowerCase().includes(n.toLowerCase())));

async function main(): Promise<void> {
  const prefix = process.argv[2];
  const n = Number(process.argv[3] ?? 8);
  if (!prefix) throw new Error("usage: search-context-ab.ts <runIdPrefix> [n]");
  const [run] = await sql`
    select r.id, r.project_id, v.frozen_prompts from runs r
    join prompt_set_versions v on v.id = r.prompt_set_version_id
    where r.id::text like ${prefix + "%"}`;
  if (!run) throw new Error("run not found");
  const prompts = (run.frozenPrompts as { text: string }[]).slice(0, n).map((p) => p.text);
  const names = (await listCompaniesForProject(run.projectId as string)).map((c) => c.name);
  const client = new OpenAI({ maxRetries: 2 });

  let agree = 0;
  let totalDef = 0;
  let totalLow = 0;
  let inDef = 0;
  let inLow = 0;
  for (const p of prompts) {
    const [d, l] = await Promise.all([ask(client, p, null), ask(client, p, "low")]);
    const nd = named(d.text, names);
    const nl = named(l.text, names);
    const union = new Set([...nd, ...nl]).size;
    const inter = [...nd].filter((x) => nl.has(x)).length;
    const jaccard = union === 0 ? 1 : inter / union;
    if (jaccard >= 0.8) agree += 1;
    totalDef += nd.size;
    totalLow += nl.size;
    inDef += d.tokensIn;
    inLow += l.tokensIn;
    console.log(`${jaccard.toFixed(2)} overlap | default named ${nd.size} (${d.tokensIn}tok) vs low ${nl.size} (${l.tokensIn}tok) | ${p.slice(0, 70)}`);
  }
  console.log(`\n${agree}/${prompts.length} prompts with ≥0.8 entity overlap`);
  console.log(`entities named: default ${totalDef} vs low ${totalLow}`);
  console.log(`avg input tokens: default ${Math.round(inDef / prompts.length)} vs low ${Math.round(inLow / prompts.length)} (${Math.round((1 - inLow / Math.max(inDef, 1)) * 100)}% reduction)`);
  console.log("Adopt low only if overlap is high and named-entity counts are comparable.");
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
