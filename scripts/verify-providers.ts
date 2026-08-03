/**
 * Live-verify dormant provider adapters (roadmap 1.7). Both Anthropic and
 * Perplexity were implemented in 2026-07 but never executed against a real
 * API — their in-file comments say exactly that. This calls each with a
 * tiny prompt and reports what came back, so "implemented_unverified"
 * can honestly become "verified" (or the model ids get fixed).
 *
 * Usage: npx tsx scripts/verify-providers.ts   (spends a few cents)
 */
// Must be the first import — later imports read env at module load, and
// hoisting would otherwise run them before a dotenv.config() call.
import "dotenv/config";
import { getProvider } from "@/lib/ai/registry";
import { extractCitations } from "@/lib/ai/citations";
import type { ProviderId } from "@/lib/ai/types";

const PROMPT = "In one sentence: what is a real estate brokerage?";
const SEARCH_PROMPT = "What is the tallest residential building in Manhattan? Answer in one sentence.";

async function tryModel(providerId: ProviderId, model: string, prompt: string) {
  const provider = getProvider(providerId);
  const started = Date.now();
  try {
    const result = await provider.runPrompt({ model, promptText: prompt });
    const citations = extractCitations(providerId, result.rawPayload);
    console.log(`✔ ${providerId}/${model}`);
    console.log(`  latency=${Date.now() - started}ms tokensIn=${result.tokensIn} tokensOut=${result.tokensOut}`);
    console.log(`  shapeRecognized=${result.shapeRecognized !== false} refusal=${result.refusal}`);
    console.log(`  citations=${citations.length}`);
    console.log(`  text: ${result.responseText.slice(0, 140).replace(/\n/g, " ")}`);
  } catch (err) {
    console.log(`✘ ${providerId}/${model}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main() {
  await tryModel("anthropic", "claude-sonnet-5", PROMPT);
  await tryModel("anthropic", "claude-sonnet-5+search", SEARCH_PROMPT);
  await tryModel("perplexity", "sonar", SEARCH_PROMPT);
}

void main();
