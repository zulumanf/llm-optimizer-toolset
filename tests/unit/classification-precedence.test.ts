/**
 * Public classification precedence (spec 141): versioned revisions, verified-
 * only public use, heuristic-vs-LLM disagreement handling, manual-review
 * exclusion, and the immutability guarantees the rule relies on.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adjudicate, adjudicateOffline, excerptGrounded, deriveStatus, resolvePublicClassification, type MentionRevisionRow } from "@/lib/parsing/precedence";
import { KNOWN_PARSER_VERSIONS } from "@/lib/parsing/version";
import { PARSER_VERSION_ADJUDICATION, PARSER_VERSION_HEURISTIC, PARSER_VERSION_LLM } from "@/lib/constants";

const llm = (rev: number, recommended: boolean, confidence = 0.95): MentionRevisionRow => ({ revision: rev, parserVersion: PARSER_VERSION_LLM, confidence, needsReview: false, mentioned: true, recommended });
const heur = (rev: number, recommended: boolean): MentionRevisionRow => ({ revision: rev, parserVersion: PARSER_VERSION_HEURISTIC, confidence: 0.85, needsReview: false, mentioned: true, recommended });
const adj = (rev: number, recommended: boolean, status: MentionRevisionRow["verificationStatus"]): MentionRevisionRow => ({ revision: rev, parserVersion: PARSER_VERSION_ADJUDICATION, confidence: 0.9, needsReview: status === "needs_manual_review", mentioned: true, recommended, verificationStatus: status });

describe("immutable raw answers and revisions", () => {
  it("responses and mentions carry forbid_mutation triggers; revision 3 adds columns only", () => {
    expect(readFileSync("db/migrations/003_runs.sql", "utf8")).toMatch(/create trigger responses_immutable\s+before update or delete on responses/);
    expect(readFileSync("db/migrations/004_classification.sql", "utf8")).toMatch(/create trigger mentions_immutable\s+before update or delete on mentions/);
    const m116 = readFileSync("db/migrations/116_mention_verification_status.sql", "utf8");
    expect(m116).toMatch(/add column if not exists verification_status/);
    expect(m116).not.toMatch(/\bupdate mentions\b|\bdelete from\b|\bdrop table\b/i);
  });
  it("every parser version is registered and the adjudication version is distinct", () => {
    expect(KNOWN_PARSER_VERSIONS).toEqual(expect.arrayContaining([PARSER_VERSION_HEURISTIC, PARSER_VERSION_LLM, PARSER_VERSION_ADJUDICATION]));
    expect(new Set(KNOWN_PARSER_VERSIONS).size).toBe(3);
  });
});

describe("status derivation", () => {
  it("legacy LLM rows are verified at or above 0.7, heuristic rows are directional, flagged rows need review", () => {
    expect(deriveStatus(llm(1, true))).toBe("verified");
    expect(deriveStatus(llm(1, true, 0.6))).toBe("needs_manual_review");
    expect(deriveStatus(heur(2, false))).toBe("directional");
    expect(deriveStatus({ ...llm(1, true), needsReview: true })).toBe("needs_manual_review");
    expect(deriveStatus(adj(3, true, "verified"))).toBe("verified");
  });
});

describe("public precedence", () => {
  it("a newer heuristic revision never overrides a verified LLM revision", () => {
    const r = resolvePublicClassification([llm(1, true), heur(2, false)]);
    expect(r).toMatchObject({ kind: "verified", row: { revision: 1, recommended: true } });
  });
  it("heuristic-only pairs have no public judgment", () => {
    expect(resolvePublicClassification([heur(1, true), heur(2, true)])).toEqual({ kind: "absent" });
  });
  it("a verified adjudication revision wins over both earlier rows", () => {
    const r = resolvePublicClassification([llm(1, true), heur(2, false), adj(3, false, "verified")]);
    expect(r).toMatchObject({ kind: "verified", row: { revision: 3, recommended: false } });
  });
  it("a manual-review revision newer than every verified row blocks the pair", () => {
    expect(resolvePublicClassification([llm(1, true), heur(2, false), adj(3, true, "needs_manual_review")])).toMatchObject({ kind: "blocked" });
    expect(resolvePublicClassification([heur(1, true), adj(2, true, "needs_manual_review")])).toMatchObject({ kind: "blocked" });
  });
  it("a human-reviewed row newer than a manual-review row unblocks the pair and outranks every parser", () => {
    const human: MentionRevisionRow = { revision: 3, parserVersion: PARSER_VERSION_HEURISTIC, confidence: 1, needsReview: false, mentioned: true, recommended: true, reviewed: true };
    expect(resolvePublicClassification([adj(2, true, "needs_manual_review"), human])).toMatchObject({ kind: "verified", row: { revision: 3 } });
    expect(deriveStatus(human)).toBe("verified");
  });
});

describe("adjudication of heuristic-versus-LLM disagreement", () => {
  const J = (recommended: boolean, confidence = 0.9) => ({ mentioned: true, recommended, confidence });
  it("two concurring classifier judgments verify; heuristic dissent is only recorded", () => {
    expect(adjudicate(J(true), J(false), J(true))).toMatchObject({ status: "verified" });
  });
  it("a fresh classifier that sides with the heuristic verifies (2 of 3)", () => {
    expect(adjudicate(J(true), J(false), J(false))).toMatchObject({ status: "verified", reason: expect.stringContaining("2 of 3") });
  });
  it("low confidence or a three-way split goes to manual review, never forced", () => {
    expect(adjudicate(J(true), J(false), J(true, 0.5)).status).toBe("needs_manual_review");
    expect(adjudicate({ mentioned: true, recommended: true, confidence: 0.9 }, { mentioned: false, recommended: false, confidence: 0.8 }, { mentioned: true, recommended: false, confidence: 0.9 }).status).toBe("needs_manual_review");
  });
  it("heuristic-only pairs are verified by one strong classifier judgment, like any revision-1 row", () => {
    expect(adjudicate(null, J(true), J(true)).status).toBe("verified");
    expect(adjudicate(null, J(true), J(true, 0.6)).status).toBe("needs_manual_review");
  });
});

describe("offline adjudication (classifier unavailable)", () => {
  const rev1 = (recommended: boolean, confidence: number, excerpt: string | null = "A strong starting recommendation is X") => ({ mentioned: true, recommended, confidence, excerpt });
  it("retains a grounded, high-confidence classifier judgment and records the dissent", () => {
    const v = adjudicateOffline(rev1(true, 0.97), { aliasInText: true, excerptInText: true });
    expect(v.status).toBe("verified");
    expect(v.reason).toMatch(/heuristic dissent recorded/);
  });
  it("sends ungrounded, weak, or contradicted judgments to manual review", () => {
    expect(adjudicateOffline(rev1(true, 0.97), { aliasInText: false, excerptInText: true }).status).toBe("needs_manual_review");
    expect(adjudicateOffline(rev1(true, 0.97), { aliasInText: true, excerptInText: false }).status).toBe("needs_manual_review");
    expect(adjudicateOffline(rev1(true, 0.85), { aliasInText: true, excerptInText: true }).status).toBe("needs_manual_review");
    expect(adjudicateOffline({ mentioned: false, recommended: false, confidence: 0.85, excerpt: null }, { aliasInText: true, excerptInText: null }).status).toBe("needs_manual_review");
  });
  it("a pair with no classifier judgment is not_classified: excluded, never a zero, never blocking", () => {
    expect(adjudicateOffline(null, { aliasInText: true, excerptInText: null }).status).toBe("not_classified");
    const row: MentionRevisionRow = { revision: 2, parserVersion: PARSER_VERSION_ADJUDICATION, confidence: 0, needsReview: false, mentioned: false, recommended: false, verificationStatus: "not_classified" };
    expect(resolvePublicClassification([heur(1, true), row])).toEqual({ kind: "absent" });
  });
});

describe("excerpt grounding", () => {
  const text = "For **luxury property in Jersey City**, a strong first call would be **Michelle Mumoli at Compass**. ([zillow.com](https://z.example)) Her profile highlights new construction.";
  it("ignores markdown, links and punctuation but not words", () => {
    expect(excerptGrounded(text, "a strong first call would be Michelle Mumoli at Compass")).toBe(true);
    expect(excerptGrounded(text, "a strong first call would be Michelle Mumoli at Corcoran")).toBe(false);
  });
  it("requires every ellipsis-separated fragment and returns null without an excerpt", () => {
    expect(excerptGrounded(text, "a strong first call would be... Her profile highlights new construction")).toBe(true);
    expect(excerptGrounded(text, "a strong first call would be... nothing of the sort was said here")).toBe(false);
    expect(excerptGrounded(text, null)).toBeNull();
  });
});
