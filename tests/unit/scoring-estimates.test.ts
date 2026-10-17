import { describe, expect, it } from "vitest";
import {
  computeEstimates,
  groupByInstrument,
  type EstimateCompany,
  type EstimateMention,
  type EstimateResponse,
} from "@/lib/scoring/estimates";
import { extractServedModel, instrumentKey, searchModeOf } from "@/lib/ai/served-model";

const subject: EstimateCompany = { id: "s", name: "Rivera Team", aliases: [], domain: "riverateam.com" };
const rival: EstimateCompany = { id: "r", name: "Meridian Group", aliases: [], domain: "meridian.com" };

function responses(provider: string, model: string, prompts: number, reps: number, promptText = "best agent in Springfield"): EstimateResponse[] {
  const out: EstimateResponse[] = [];
  for (let p = 0; p < prompts; p += 1) {
    for (let r = 0; r < reps; r += 1) {
      out.push({
        id: `${provider}:${model}:${p}:${r}`,
        provider,
        model,
        promptId: `p${p}`,
        promptText,
        requestParams: { sampling: "provider_default" },
        servedModel: model.replace("+search", ""),
        hasAnyCitation: true,
      });
    }
  }
  return out;
}

const mention = (responseId: string, companyId: string, extra: Partial<EstimateMention> = {}): EstimateMention => ({
  responseId,
  companyId,
  mentioned: true,
  recommended: false,
  listPosition: null,
  sentiment: "neutral",
  citedUrls: [],
  ...extra,
});

describe("served-model and instrument identity", () => {
  it("extracts what the provider reports, never guesses", () => {
    expect(extractServedModel("openai", { model: "gpt-5.4-mini-2026-03-17" })).toBe("gpt-5.4-mini-2026-03-17");
    expect(extractServedModel("google", { modelVersion: "gemini-3-pro-001" })).toBe("gemini-3-pro-001");
    expect(extractServedModel("perplexity", {})).toBeNull();
    expect(extractServedModel("openai", null)).toBeNull();
  });
  it("search mode and sampling are part of the instrument", () => {
    expect(searchModeOf("gpt-5.4-mini+search")).toBe("web_search");
    expect(instrumentKey({ provider: "openai", model: "a" })).not.toBe(
      instrumentKey({ provider: "openai", model: "a", sampling: "temperature=0" })
    );
  });
});

describe("computeEstimates (scoring v1.2)", () => {
  it("never blends two models of one provider; single-instrument providers keep a provider row", () => {
    const rs = [
      ...responses("openai", "gpt-a", 6, 2),
      ...responses("openai", "gpt-b+search", 6, 2),
      ...responses("perplexity", "sonar", 6, 2),
    ];
    const ms = rs.filter((r) => r.model === "gpt-a").map((r) => mention(r.id, "s"));
    const { estimates, compat, instruments } = computeEstimates({ runId: "run", responses: rs, mentions: ms, companies: [subject, rival] });

    expect(instruments).toHaveLength(3);
    expect(groupByInstrument(rs).map((g) => g.model)).toEqual(["gpt-a", "gpt-b+search", "sonar"]);
    const mentionRates = estimates.filter((e) => e.companyId === "s" && e.metric === "mention_rate");
    expect(mentionRates.map((e) => [e.model, e.rate])).toEqual([
      ["gpt-a", 1],
      ["gpt-b+search", 0],
      ["sonar", 0],
    ]);
    // No provider='openai' row: it would be a blend of two instruments.
    expect(compat.some((c) => c.provider === "openai")).toBe(false);
    expect(compat.some((c) => c.provider === "perplexity" && c.metric === "mention_rate")).toBe(true);
    // 'all' = unweighted mean across instruments (1 + 0 + 0) / 3.
    const all = compat.find((c) => c.companyId === "s" && c.provider === "all" && c.metric === "mention_rate");
    expect(all?.value).toBeCloseTo(1 / 3, 10);
    expect(all?.sampleSize).toBe(36);
  });

  it("carries numerator, denominator, distinct prompts and both intervals", () => {
    const rs = responses("openai", "gpt-a", 10, 4);
    const ms = rs.filter((r) => Number(r.promptId.slice(1)) < 3).map((r) => mention(r.id, "s", { recommended: true }));
    const { estimates } = computeEstimates({ runId: "run", responses: rs, mentions: ms, companies: [subject] });
    const rec = estimates.find((e) => e.metric === "recommendation_rate");
    expect(rec).toMatchObject({ numerator: 12, denominator: 40, distinctPrompts: 10, rate: 0.3 });
    expect(rec?.wilson?.[0]).toBeLessThan(0.3);
    expect(rec?.clustered).not.toBeNull();
    // Perfectly clustered answers → ICC 1, wider clustered interval.
    const men = estimates.find((e) => e.metric === "mention_rate");
    expect(men?.icc).toBeCloseTo(1, 6);
    const width = (i: readonly [number, number] | null) => (i ? i[1] - i[0] : 0);
    expect(width(men?.clustered ?? null)).toBeGreaterThan(width(men?.wilson ?? null));
  });

  it("is deterministic (seeded bootstrap)", () => {
    const rs = responses("openai", "gpt-a", 8, 3);
    const ms = rs.filter((_, i) => i % 3 === 0).map((r) => mention(r.id, "s"));
    const a = computeEstimates({ runId: "run", responses: rs, mentions: ms, companies: [subject] });
    const b = computeEstimates({ runId: "run", responses: rs, mentions: ms, companies: [subject] });
    expect(a).toEqual(b);
  });

  it("excludes echo answers from the organic estimates and counts them", () => {
    const organic = responses("openai", "gpt-a", 5, 2);
    const echo = responses("openai", "gpt-a", 5, 2, "is Rivera Team any good?").map((r) => ({
      ...r,
      id: `${r.id}:echo`,
      promptId: `${r.promptId}e`,
    }));
    const ms = echo.map((r) => mention(r.id, "s"));
    const { estimates, compat } = computeEstimates({ runId: "run", responses: [...organic, ...echo], mentions: ms, companies: [subject] });
    const est = estimates.find((e) => e.metric === "mention_rate");
    expect(est).toMatchObject({ numerator: 0, denominator: 10, excludedEcho: 10 });
    // The compatibility row keeps the v1.1 all-answers scope.
    expect(compat.find((c) => c.provider === "openai" && c.metric === "mention_rate")?.value).toBe(0.5);
  });

  it("owned citations use the dot-boundary rule", () => {
    const rs = responses("openai", "gpt-a", 5, 1);
    const ms = rs.map((r, i) =>
      mention(r.id, "s", { citedUrls: [i === 0 ? "https://blog.riverateam.com/x" : "https://notriverateam.com/y"] })
    );
    const { estimates } = computeEstimates({ runId: "run", responses: rs, mentions: ms, companies: [subject] });
    expect(estimates.find((e) => e.metric === "owned_citation_rate")).toMatchObject({ numerator: 1, denominator: 5 });
  });

  it("share of voice counts only the scored universe", () => {
    const rs = responses("openai", "gpt-a", 5, 1);
    const ms = rs.flatMap((r) => [mention(r.id, "s"), mention(r.id, "outsider")]);
    const { estimates } = computeEstimates({ runId: "run", responses: rs, mentions: ms, companies: [subject, rival] });
    const sov = estimates.find((e) => e.companyId === "s" && e.metric === "share_of_voice");
    expect(sov).toMatchObject({ numerator: 5, denominator: 5, rate: 1 });
  });
});

describe("default instrument override", () => {
  it("uses the code default, or a validated env override, and refuses bad JSON", async () => {
    const { defaultMeasurementInstrument } = await import("@/lib/measurement/constants");
    expect(defaultMeasurementInstrument({}).source).toBe("code_default");
    const o = defaultMeasurementInstrument({ MEASUREMENT_DEFAULT_INSTRUMENT: '[{"provider":"mock","model":"mock-model","repetitions":2}]' });
    expect(o).toEqual({ source: "env_override", providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }] });
    expect(() => defaultMeasurementInstrument({ MEASUREMENT_DEFAULT_INSTRUMENT: "nope" })).toThrow(/JSON/);
    expect(() => defaultMeasurementInstrument({ MEASUREMENT_DEFAULT_INSTRUMENT: '[{"provider":"x","model":"y","repetitions":99}]' })).toThrow();
  });
});
