/**
 * Unit tests for independent verification and adversarial QA
 * (spec 018 Parts 10-11).
 *
 * The load-bearing test is the allow-list one: the ban on a verifier seeing
 * the creator's reasoning is only real if it is structural. If a caller can
 * leak a `reasoning` field through by passing a fat object, the whole
 * "creator may not verify its own work" property is decoration.
 */
import { describe, expect, it } from "vitest";
import {
  buildVerifierContext,
  verifyArtifact,
  adversarialReview,
  blockingIssues,
  isDisagreement,
  FORBIDDEN_VERIFIER_FIELDS,
} from "@/lib/agents/verification";
import { renderPacket, type EvidencePacket } from "@/lib/knowledge/packet";
import type { AgentCaller } from "@/lib/ai/agent";
import { getAgent, implementedAgents, AGENTS } from "@/lib/agents/registry";

const packet: EvidencePacket = {
  id: null,
  projectId: "p1",
  purpose: "test",
  audience: "public",
  claims: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      key: "transactions_2025",
      text: "Closed 120 transactions in 2025.",
      value: 120,
      predicate: "closed_transactions",
      category: "performance",
      asOf: "2026-01-31",
      effectiveDate: "2025-01-01",
      reviewDate: "2027-01-01",
      verificationStatus: "verified",
      confidence: 0.95,
      privacyStatus: "public",
      allowedWording: ["closed 120 transactions in 2025"],
      prohibitedWording: ["#1 agent", "best in the city"],
      evidenceIds: ["22222222-2222-4222-8222-222222222222"],
      stale: false,
    },
  ],
  sources: [
    {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "url",
      note: "MLS export",
      url: "https://example.com/mls",
      createdAt: "2026-02-01T00:00:00.000Z",
      ageDays: 30,
    },
  ],
  contradictions: [],
  withheldClaimIds: ["33333333-3333-4333-8333-333333333333"],
  requiredDisclaimers: [],
  methodologyVersion: null,
  contentHash: "hash",
};

describe("buildVerifierContext", () => {
  it("carries the artifact, evidence, rubric, and approved claims", () => {
    const context = buildVerifierContext({
      artifact: "The agent closed 120 transactions.",
      packet,
      rubric: ["Every factual statement must be supported."],
    });
    expect(context.artifact).toContain("120 transactions");
    expect(context.rubric).toHaveLength(1);
    expect(context.approvedClaims).toEqual([
      { id: packet.claims[0]!.id, text: packet.claims[0]!.text },
    ]);
    expect(context.evidence).toContain("Closed 120 transactions in 2025.");
  });

  it("exposes exactly four fields — nothing about the creator can ride along", () => {
    const context = buildVerifierContext({
      artifact: "x",
      packet,
      rubric: [],
    });
    expect(Object.keys(context).sort()).toEqual([
      "approvedClaims",
      "artifact",
      "evidence",
      "rubric",
    ]);
  });

  it("cannot leak a creator field even when the caller passes one", () => {
    const fat = {
      artifact: "x",
      packet,
      rubric: [],
      // Everything a creator might attach, all at once.
      ...Object.fromEntries(FORBIDDEN_VERIFIER_FIELDS.map((f) => [f, "LEAKED"])),
    } as Parameters<typeof buildVerifierContext>[0];

    const context = buildVerifierContext(fat);
    const serialised = JSON.stringify(context);
    expect(serialised).not.toContain("LEAKED");
    for (const field of FORBIDDEN_VERIFIER_FIELDS) {
      expect(context).not.toHaveProperty(field);
    }
  });

  it("handles a missing packet without inventing evidence", () => {
    const context = buildVerifierContext({ artifact: "x", packet: null, rubric: [] });
    expect(context.evidence).toContain("no evidence packet");
    expect(context.approvedClaims).toEqual([]);
  });
});

describe("verifyArtifact", () => {
  it("returns the structured verdict and never sees creator reasoning in its prompt", async () => {
    let seenUser = "";
    const caller: AgentCaller = async ({ user }) => {
      seenUser = user;
      return {
        text: JSON.stringify({
          decision: "approved",
          errorsFound: [],
          unsupportedClaims: [],
          missingEvidence: [],
          contradictions: [],
          severity: "none",
          requiredCorrection: "",
          confidence: 0.9,
          humanReviewRecommended: false,
        }),
        tokensIn: 100,
        tokensOut: 20,
      };
    };
    const result = await verifyArtifact({
      context: buildVerifierContext({
        artifact: "Closed 120 transactions in 2025.",
        packet,
        rubric: ["Support every fact."],
      }),
      caller,
    });
    expect(result.output.decision).toBe("approved");
    expect(seenUser).toContain("Artifact under review");
    expect(seenUser).not.toMatch(/believed to be correct|the drafter|self-evaluation/i);
  });

  it("distinguishes insufficient_evidence from rejected", async () => {
    const caller: AgentCaller = async () => ({
      text: JSON.stringify({
        decision: "insufficient_evidence",
        missingEvidence: ["no source for the 2025 figure"],
        confidence: 0.4,
      }),
      tokensIn: 10,
      tokensOut: 10,
    });
    const result = await verifyArtifact({
      context: buildVerifierContext({ artifact: "x", packet: null, rubric: [] }),
      caller,
    });
    expect(result.output.decision).toBe("insufficient_evidence");
    expect(result.output.missingEvidence).toHaveLength(1);
    // Defaults fill in the fields the model omitted, so downstream code never
    // has to guard against undefined.
    expect(result.output.errorsFound).toEqual([]);
  });
});

describe("adversarialReview", () => {
  it("asks every adversarial question and returns issues", async () => {
    let seenUser = "";
    const caller: AgentCaller = async ({ user }) => {
      seenUser = user;
      return {
        text: JSON.stringify({
          issues: [
            {
              question: "What is overstated?",
              issue: '"best in the city" is an unsupported superlative',
              severity: "high",
              suggestedFix: "remove it",
              quote: "best in the city",
            },
          ],
          overallRisk: "high",
        }),
        tokensIn: 200,
        tokensOut: 60,
      };
    };
    const result = await adversarialReview({
      artifact: "We are the best in the city.",
      packet,
      caller,
    });
    expect(result.output.issues).toHaveLength(1);
    expect(seenUser).toContain("What could create legal risk?");
    expect(seenUser).toContain("What attribution statement overclaims causality?");
  });

  it("blockingIssues selects only high and critical", () => {
    const issues = blockingIssues({
      overallRisk: "high",
      issues: [
        { question: "q", issue: "a", severity: "low", suggestedFix: "", quote: "" },
        { question: "q", issue: "b", severity: "medium", suggestedFix: "", quote: "" },
        { question: "q", issue: "c", severity: "high", suggestedFix: "", quote: "" },
        { question: "q", issue: "d", severity: "critical", suggestedFix: "", quote: "" },
      ],
    });
    expect(issues.map((i) => i.issue)).toEqual(["c", "d"]);
  });
});

describe("isDisagreement", () => {
  const verdict = (decision: string) =>
    ({
      decision,
      errorsFound: [],
      unsupportedClaims: [],
      missingEvidence: [],
      contradictions: [],
      severity: "none",
      requiredCorrection: "",
      confidence: 0.8,
      humanReviewRecommended: false,
    }) as Parameters<typeof isDisagreement>[0]["verdict"];

  it("treats rejection, insufficient evidence, and human-review as disagreement", () => {
    for (const decision of ["rejected", "insufficient_evidence", "human_review_required"]) {
      expect(isDisagreement({ creatorConfidence: 0.5, verdict: verdict(decision) })).toBe(true);
    }
  });

  it("flags a confident creator whose work needed corrections", () => {
    expect(
      isDisagreement({
        creatorConfidence: 0.95,
        verdict: verdict("approved_with_minor_corrections"),
      })
    ).toBe(true);
  });

  it("does not flag plain agreement", () => {
    expect(isDisagreement({ creatorConfidence: 0.95, verdict: verdict("approved") })).toBe(false);
  });
});

describe("agent registry", () => {
  it("every agent declares scopes, prohibitions, and evidence requirements", () => {
    for (const agent of AGENTS) {
      expect(agent.allowedDataScopes.length, agent.key).toBeGreaterThan(0);
      expect(agent.prohibitedActions.length, agent.key).toBeGreaterThan(0);
      expect(agent.evidenceRequirements.length, agent.key).toBeGreaterThan(0);
    }
  });

  it("no agent is permitted to write to the database or publish", () => {
    for (const agent of AGENTS) {
      const prohibitions = agent.prohibitedActions.join(" ");
      expect(prohibitions, agent.key).toContain("write to any database table");
      expect(prohibitions, agent.key).toContain("publish, send, or submit");
    }
  });

  it("agent keys are unique", () => {
    const keys = AGENTS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("verifier agents are forbidden from seeing the creator's reasoning", () => {
    const verifier = getAgent("independent_artifact_verifier")!;
    expect(verifier.prohibitedActions.join(" ")).toContain("hidden reasoning");
    expect(verifier.prohibitedActions.join(" ")).toContain("self-evaluation");
  });

  it("reports implemented agents honestly — a declared agent is not counted as working", () => {
    const implemented = implementedAgents();
    expect(implemented.length).toBeGreaterThan(0);
    expect(implemented.length).toBeLessThan(AGENTS.length);
    for (const agent of implemented) {
      expect(agent.module, agent.key).toBeTruthy();
    }
  });
});

describe("renderPacket", () => {
  it("states allowed and prohibited wording per claim", () => {
    const rendered = renderPacket(packet);
    expect(rendered).toContain("use wording: closed 120 transactions in 2025");
    expect(rendered).toContain("never say: #1 agent | best in the city");
  });

  it("warns explicitly when a claim is past its review date", () => {
    const stale = {
      ...packet,
      claims: [{ ...packet.claims[0]!, stale: true }],
    };
    expect(renderPacket(stale)).toContain("PAST REVIEW DATE");
  });

  it("tells the agent plainly when there is nothing it may state", () => {
    const empty = { ...packet, claims: [], sources: [] };
    expect(renderPacket(empty)).toContain("you must not state any client fact");
  });
});
