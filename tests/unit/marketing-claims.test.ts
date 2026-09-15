/**
 * Approved-claims registry guardrails: every public number must trace to an
 * approved claim with a denominator and date, use truthful provider labels,
 * and carry none of the phrases the prospect-voice rules ban.
 */
import { describe, expect, it } from "vitest";
import { APPROVED_CLAIMS, claim, claimNumber, domainRows, pct } from "@/lib/marketing/claims";
import { findProhibitedPhrase } from "@/lib/prospects/constants";
import { FAQ } from "@/lib/marketing/faq";
import { MARKETING_PAGES } from "@/lib/marketing/constants";
import { findBannedWording, INSTRUMENT_LABEL_OPENAI } from "@/lib/marketing/wording";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import release from "@/data/public/real-estate-ai-visibility-benchmark.json";

const REQUIRED = ["id", "status", "claim", "source", "benchmarkDate", "market", "instrument", "denominator", "publicWording", "prohibitedWording", "anonymization", "lastVerified", "values", "verification"] as const;

function walk(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(tsx?|json)$/.test(f)) out.push(p);
  }
  return out;
}

const JC_RUNS = ["99af19b4-3fff-4a05-b3a0-80135e5f588b"];

describe("approved-claims registry", () => {
  it("has unique ids and every required field", () => {
    expect(new Set(APPROVED_CLAIMS.map((c) => c.id)).size).toBe(APPROVED_CLAIMS.length);
    for (const c of APPROVED_CLAIMS) {
      for (const k of REQUIRED) expect(c, c.id).toHaveProperty(k);
      expect(c.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Object.keys(c.values).length).toBeGreaterThan(0);
    }
  });

  it("approved public wording is denominator-bearing, label-truthful and free of banned phrases", () => {
    for (const c of APPROVED_CLAIMS.filter((x) => x.status === "approved")) {
      expect(c.denominator.length, c.id).toBeGreaterThan(5);
      expect(findProhibitedPhrase(c.publicWording), c.id).toBeNull();
      for (const banned of c.prohibitedWording) expect(c.publicWording.toLowerCase(), `${c.id}: ${banned}`).not.toContain(banned.toLowerCase());
      expect(c.publicWording, c.id).not.toMatch(/\bChatGPT recommended\b/);
    }
  });

  it("pending claims are not readable by pages", () => {
    const pending = APPROVED_CLAIMS.find((c) => c.status !== "approved");
    expect(pending).toBeDefined();
    expect(() => claim(pending!.id)).toThrow(/not approved/);
    expect(() => claim("does-not-exist")).toThrow(/Unknown claim/);
  });

  it("arithmetic helpers refuse blanks and honour public exclusions", () => {
    expect(claimNumber("jc-2026-08-31-summary", "answers")).toBe(128);
    expect(() => claimNumber("jc-2026-08-31-summary", "nope")).toThrow();
    expect(pct(102, 128)).toBe("80%");
    expect(pct(1, 0)).toBe("not measured");
    const rows = domainRows("jc-2026-08-31-top-domains");
    expect(rows[0]?.domain).toBe("zillow.com");
    expect(rows.some((r) => r.domain === "thejillbiggsgroup.com")).toBe(false);
    expect(rows.some((r) => r.domain === "hobokenpainter.com")).toBe(true);
  });

  it("public copy (FAQ, page descriptions) carries no banned phrases", () => {
    for (const f of FAQ) expect(findProhibitedPhrase(f.a), f.q).toBeNull();
    for (const p of MARKETING_PAGES) expect(findProhibitedPhrase(p.description), p.path).toBeNull();
  });

  it("markets are never mixed: Jersey City claims cite only Jersey City runs and Greenville only Greenville", () => {
    for (const c of APPROVED_CLAIMS) {
      const v = c.verification;
      if (c.id.startsWith("jc-")) {
        expect(c.market).toBe("Jersey City, NJ");
        expect("runId" in v && JC_RUNS.includes(v.runId), c.id).toBe(true);
      }
      if (c.id.startsWith("greenville")) {
        expect(c.market).toBe("Greenville, SC");
        expect("runId" in v && !JC_RUNS.includes(v.runId), c.id).toBe(true);
      }
      expect(c.instrument).toContain(INSTRUMENT_LABEL_OPENAI);
    }
  });

  it("the public dataset agrees with the registry for every approved run claim", () => {
    const rows = (release as { benchmarks: Record<string, unknown>[] }).benchmarks;
    for (const c of APPROVED_CLAIMS.filter((x) => x.status === "approved" && x.verification.query === "run_by_provider")) {
      const runId = (c.verification as { runId: string }).runId;
      for (const provider of ["openai", "perplexity"]) {
        const row = rows.find((r) => r.run_id === runId && r.provider === provider);
        expect(row, `${c.id} ${provider}`).toBeDefined();
        expect(String(row!.valid_answers)).toBe(String(c.values[`${provider}_answers`]));
        expect(String(row!.answers_with_recommendation)).toBe(String(c.values[`${provider}_answersWithRecommendation`]));
        expect(String(row!.distinct_entities_recommended)).toBe(String(c.values[`${provider}_entitiesRecommended`]));
        expect(String(row!.top_entity_recommendations)).toBe(String(c.values[`${provider}_topEntityRecommendations`]));
        expect(String(row!.blocked_pairs), `${c.id} ${provider} blocked pairs disclosed`).toBe(String(c.values[`${provider}_blockedPairs`] ?? 0));
      }
    }
  });

  it("no public source describes API captures as ChatGPT behaviour or guarantees anything", () => {
    const files = [...walk("app/(marketing)"), ...walk("lib/marketing"), ...walk("data/public")].filter((f) => !f.endsWith("approved-claims.json"));
    for (const f of files) {
      const hit = findBannedWording(readFileSync(f, "utf8"));
      expect(hit, `${f}: ${hit?.match}`).toBeNull();
    }
  });

  it("denominator drift is detectable: registry answers equal prompts × repetitions × providers for the Jersey City run", () => {
    const s = claim("jc-2026-08-31-summary");
    expect(s.values.answers).toBe(Number(s.values.prompts) * 4 * 2);
  });
});
