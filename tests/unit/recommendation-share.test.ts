/**
 * AI Recommendation Share (spec 087): known-answer fixtures. The invariants:
 * the share reconciles to the mention rows, raw counts always travel with
 * the rate, echo exclusion applies symmetrically, and small segments say
 * insufficient_data instead of quoting a percentage.
 */
import { describe, it, expect } from "vitest";
import {
  computeRecommendationShare,
  MIN_RECOMMENDATION_MOMENTS,
  REC_SHARE_VERSION,
} from "@/lib/scoring/recommendation-share";
import { promptContexts } from "@/lib/competitors/displacement";
import type { RunMentionRow, ValidResponseRow } from "@/db/displacement";
import type { FrozenPrompt } from "@/lib/prompts/types";

const SUBJECT = "subject-co";
const RIVAL = "rival-co";

function frozen(
  id: string,
  text: string,
  overrides: Partial<FrozenPrompt> = {}
): FrozenPrompt {
  return {
    promptId: id,
    text,
    category: "recommendation",
    language: "en",
    position: 1,
    ...overrides,
  };
}

function mention(
  responseId: string,
  companyId: string,
  overrides: Partial<RunMentionRow> = {}
): RunMentionRow {
  return {
    responseId,
    companyId,
    companyName: companyId,
    mentioned: true,
    recommended: true,
    listPosition: null,
    promptEchoed: false,
    ...overrides,
  };
}

function fixture(promptCount: number) {
  const prompts = Array.from({ length: promptCount }, (_, i) =>
    frozen(`p${i}`, `best listing agent question ${i}`, {
      tier: i < promptCount / 2 ? 1 : 4,
      neighborhood: i % 2 === 0 ? "newport" : null,
    })
  );
  const responses: ValidResponseRow[] = prompts.map((p, i) => ({
    id: `r${i}`,
    provider: i % 2 === 0 ? "openai" : "google",
    promptId: p.promptId,
  }));
  return { prompts, responses, contexts: promptContexts(prompts) };
}

describe("computeRecommendationShare", () => {
  it("share = subject moments over all tracked recommendation moments, raw counts preserved", () => {
    const { responses, contexts } = fixture(8);
    const mentions = [
      // 6 moments: subject recommended in 2, rival in all 6.
      ...[0, 1, 2, 3, 4, 5].map((i) => mention(`r${i}`, RIVAL)),
      mention("r0", SUBJECT),
      mention("r1", SUBJECT),
      // A mentioned-but-not-recommended subject row adds no moment.
      mention("r6", SUBJECT, { recommended: false }),
    ];
    const result = computeRecommendationShare({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions,
      contexts,
    });
    expect(result.version).toBe(REC_SHARE_VERSION);
    expect(result.overall).toEqual({
      segment: "overall",
      subjectMoments: 2,
      totalMoments: 6,
      share: 2 / 6,
      status: "ok",
    });
  });

  it("echo exclusion applies to the subject exactly as to rivals", () => {
    const { responses, contexts } = fixture(8);
    const mentions = [
      ...[0, 1, 2, 3, 4, 5].map((i) => mention(`r${i}`, RIVAL)),
      // Echoed subject recommendation: our own question coming back.
      mention("r0", SUBJECT, { promptEchoed: true }),
      mention("r1", SUBJECT),
    ];
    const result = computeRecommendationShare({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions,
      contexts,
    });
    expect(result.overall.subjectMoments).toBe(1);
  });

  it("returns insufficient_data below the moment threshold — never 0%", () => {
    const { responses, contexts } = fixture(8);
    const mentions = [
      mention("r0", RIVAL),
      mention("r1", RIVAL),
    ];
    const result = computeRecommendationShare({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions,
      contexts,
    });
    expect(result.overall.totalMoments).toBeLessThan(MIN_RECOMMENDATION_MOMENTS);
    expect(result.overall.status).toBe("insufficient_data");
    expect(result.overall.share).toBeNull();
    // The raw counts still stand — insufficient hides the rate, not the data.
    expect(result.overall.subjectMoments).toBe(0);
    expect(result.overall.totalMoments).toBe(2);
  });

  it("a healthy aggregate cannot hide an insufficient or empty segment", () => {
    const { responses, contexts } = fixture(12);
    // All 12 responses are moments; subject only wins on even (openai) rows.
    const mentions = [
      ...Array.from({ length: 12 }, (_, i) => mention(`r${i}`, RIVAL)),
      ...[0, 2, 4, 6, 8, 10].map((i) => mention(`r${i}`, SUBJECT)),
    ];
    const result = computeRecommendationShare({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions,
      contexts,
    });
    expect(result.overall.share).toBe(0.5);
    const openai = result.byProvider.find((r) => r.segment === "openai")!;
    const google = result.byProvider.find((r) => r.segment === "google")!;
    expect(openai.share).toBe(1);
    expect(google.share).toBe(0);
    expect(google.status).toBe("ok"); // 6 moments — a real, sufficient zero
  });

  it("breaks down by real-estate dimension with segment counts reconciling", () => {
    const { responses, contexts } = fixture(12);
    const mentions = [
      ...Array.from({ length: 12 }, (_, i) => mention(`r${i}`, RIVAL)),
      mention("r0", SUBJECT),
    ];
    const result = computeRecommendationShare({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions,
      contexts,
    });
    const newport = result.byDimension.neighborhood?.find(
      (r) => r.segment === "newport"
    );
    expect(newport).toBeDefined();
    expect(newport!.totalMoments).toBe(6); // even-indexed responses
    expect(newport!.subjectMoments).toBe(1);
    const intent = result.byDimension.intent ?? [];
    expect(intent.reduce((s, r) => s + r.totalMoments, 0)).toBe(12);
  });

  it("holdout responses never become moments", () => {
    const prompts = [
      ...Array.from({ length: 7 }, (_, i) => frozen(`p${i}`, `q ${i}`)),
      frozen("ph", "holdout", { isHoldout: true }),
    ];
    const responses: ValidResponseRow[] = prompts.map((p, i) => ({
      id: `r${i}`,
      provider: "openai",
      promptId: p.promptId,
    }));
    const result = computeRecommendationShare({
      runId: "run",
      subjectCompanyId: SUBJECT,
      responses,
      mentions: [
        ...[0, 1, 2, 3, 4, 5].map((i) => mention(`r${i}`, RIVAL)),
        mention("r7", RIVAL), // the holdout response
      ],
      contexts: promptContexts(prompts),
    });
    expect(result.overall.totalMoments).toBe(6);
  });
});
