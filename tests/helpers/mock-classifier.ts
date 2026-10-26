/**
 * Spec 160: a contractual baseline refuses keyword-fallback classifications,
 * and the suite strips provider keys (tests/setup.ts), which pins parsing to
 * that fallback. Suites that freeze baselines therefore parse with a
 * deterministic stand-in for the LLM classifier — the same pattern as
 * parse-backfill-hardening.test.ts — instead of weakening the gate.
 *
 * In the test file (vi.mock is hoisted per file):
 *
 *   vi.mock("@/lib/parsing/classify-llm", async (orig) =>
 *     (await import("../helpers/mock-classifier")).mockClassifierModule(await orig()));
 */
import type * as ClassifyLlm from "@/lib/parsing/classify-llm";

type ClassifyArgs = { responseText: string; companies: { id: string; name: string; aliases: string[]; domain: string | null }[] };

/** Recommends every company whose name or alias appears in the answer. */
export async function mockClassifierModule(original: unknown): Promise<typeof ClassifyLlm> {
  const mod = original as typeof ClassifyLlm;
  const { scanAliases } = await import("@/lib/parsing/prepass");
  return {
    ...mod,
    classifyResponseLlm: (async (args: ClassifyArgs) => {
      const hits = new Set(scanAliases(args.responseText, args.companies).map((h) => h.companyId));
      return args.companies
        .filter((c) => hits.has(c.id))
        .map((c) => ({
          companyId: c.id, mentioned: true, recommended: true, listPosition: null, sentiment: "positive" as const,
          excerpt: null, citedUrls: [] as string[], confidence: 0.95, needsReview: false,
        }));
    }) as unknown as typeof mod.classifyResponseLlm,
  };
}

/** Run fn with the classifier "available" (a placeholder key — the module is mocked, nothing leaves). */
export async function withClassifier<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key-mock-classifier";
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved;
  }
}

/** Re-parse every valid answer of a run with the (mocked) classifier. */
export async function classifierReparse(runId: string): Promise<void> {
  const { sql } = await import("@/db/client");
  const parsing = await import("@/lib/parsing/service");
  const rows = await sql`select id from responses where run_id = ${runId} and error is null order by id`;
  await withClassifier(async () => {
    for (const r of rows) await parsing.parseResponse(r.id as string, { reparse: true });
  });
}
