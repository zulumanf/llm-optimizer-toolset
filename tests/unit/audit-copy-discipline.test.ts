/**
 * Copy discipline on prospect-facing audit surfaces (Team Moza review,
 * 2026-08-19). Source-scanning, like layout-consistency.test.ts: the
 * phrases that misstate what the benchmark proves must not reappear in the
 * page templates or the snapshot generators.
 *
 * - No consumer-product claims for an API benchmark ("we asked ChatGPT",
 *   "ChatGPT is the AI assistant"). ChatGPT may appear only as a real
 *   exhibit label (spec 045 share links) or the verify invitation.
 * - No causality the data doesn't prove ("sources AI reads", "how the
 *   answer changes", "hard to displace").
 * - No claimed lost introductions ("that introduction goes to").
 * - Mention counts are never captioned as answers ("the answer named
 *   someone specific to hire" next to the mentions total).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const SURFACES = [
  "app/audit/[handle]/page.tsx",
  "app/audit/[handle]/answers/page.tsx",
  "lib/prospects/audits.ts",
  "lib/prospects/diagnose.ts",
  // terminology.ts is deliberately absent: it QUOTES the banned phrases in
  // its doc comments as the negative examples; its behavior is tested
  // directly in audit-terminology.test.ts.
];

const BANNED = [
  "we asked ChatGPT",
  "We asked it",
  "ChatGPT is the AI assistant",
  "ChatGPT&apos;s answers",
  "sources AI reads",
  "is how the answer changes",
  "introduction goes to",
  "hard to displace",
  "the answer named someone specific to hire.",
  // Referral/lead claims (compliance pass 2026-08-19): a mention is never
  // a referral, a lead, or a lost commission.
  "sends your clients",
  "leads are going to",
  "stealing your AI leads",
];

describe("prospect-facing copy discipline", () => {
  for (const file of SURFACES) {
    it(`${file} carries no unsupported claims`, () => {
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const phrase of BANNED) {
        expect(source, `"${phrase}" found in ${file}`).not.toContain(phrase);
      }
    });
  }

  it("the audit page states mention units next to the mentions total", () => {
    const source = readFileSync(
      join(ROOT, "app/audit/[handle]/page.tsx"),
      "utf8"
    );
    expect(source).toContain("recommendation mentions across the");
    expect(source).toContain("MENTIONS_VS_ANSWERS_NOTE");
  });

  it("the page scopes its numbers and tells the reader how to read them", () => {
    const source = readFileSync(
      join(ROOT, "app/audit/[handle]/page.tsx"),
      "utf8"
    );
    expect(source).toContain("Results reflect the captured prompts");
    expect(source).toContain("How to read this report");
    expect(source).toContain("forecast of referrals");
    expect(source).toContain("Citation frequency does not establish");
    expect(source).toContain("expressly suggested hiring or using");
  });

  it("the commission block stays labeled illustrative", () => {
    const source = readFileSync(
      join(ROOT, "app/audit/[handle]/page.tsx"),
      "utf8"
    );
    expect(source).toContain("illustrative estimate");
    expect(source).toContain("not commission income");
  });

  it("the tested-system phrase derives from run metadata, not hardcoded branding", () => {
    const source = readFileSync(
      join(ROOT, "app/audit/[handle]/page.tsx"),
      "utf8"
    );
    expect(source).toContain("testedSystemPhrase(");
    expect(source).toContain("verifySuggestionApps(");
  });
});
