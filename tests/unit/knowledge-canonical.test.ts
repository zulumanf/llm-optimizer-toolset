/**
 * Specs 020/022/023/024 — freshness, contradiction rules, claim-extraction
 * guards, token budgeting, page rendering and build ordering. Pure functions;
 * the database paths live in tests/integration/knowledge-layer.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  assessFreshness,
  blocksHighRisk,
  reviewWindowDays,
  worstFreshness,
} from "@/lib/knowledge/freshness";
import {
  detectContradictions,
  type ClaimForComparison,
} from "@/lib/knowledge/contradictions/detect";
import {
  classifyMateriality,
  normalizeCategory,
  normalizePredicate,
  verifyDraft,
  type ProposedClaimDraft,
} from "@/lib/knowledge/extraction/claims";
import { applyTokenBudget, type PacketItem } from "@/lib/knowledge/context/builder";
import {
  getPacketTemplate,
  listPacketTemplates,
} from "@/lib/knowledge/context/templates";
import {
  hashContent,
  renderPage,
  validateSelection,
} from "@/lib/knowledge/compiler/compile";
import { targetsForEvent } from "@/lib/knowledge/build/stale";
import {
  ALL_PAGE_TEMPLATES,
  hotFileTemplates,
} from "@/lib/knowledge/compiler/templates";
import { HOT_FILE_TOKEN_BUDGETS, PACKET_PRIORITY } from "@/lib/knowledge/constants";
import type { PageSelection, PageTemplate } from "@/lib/knowledge/compiler/types";

const NOW = new Date("2026-07-29T12:00:00Z");

// ------------------------------------------------------------------ freshness

describe("freshness", () => {
  it("treats a claim inside its window as current", () => {
    const result = assessFreshness(
      { category: "affiliation", lastVerifiedAt: "2026-07-01" },
      NOW
    );
    expect(result.state).toBe("current");
    expect(result.blocksHighRisk).toBe(false);
  });

  it("warns before the window closes rather than at the cliff", () => {
    // 90-day window, verified 80 days ago → inside the final 20%.
    const result = assessFreshness(
      { category: "affiliation", lastVerifiedAt: "2026-05-10" },
      NOW
    );
    expect(result.state).toBe("nearing_review");
  });

  it("marks a claim past its window stale and says how far past", () => {
    const result = assessFreshness(
      { category: "affiliation", lastVerifiedAt: "2026-01-01" },
      NOW
    );
    expect(result.state).toBe("stale");
    expect(result.reason).toMatch(/review window closed \d+ days ago/);
    expect(result.blocksHighRisk).toBe(true);
  });

  it("expires a time-bounded ranking once its period ends, rather than calling it stale", () => {
    const result = assessFreshness({ category: "ranking", asOf: "2024-06-01" }, NOW);
    expect(result.state).toBe("expired");
    expect(result.reason).toContain("its period has ended");
  });

  it("keeps a ranking current inside its own year", () => {
    expect(assessFreshness({ category: "ranking", asOf: "2026-03-01" }, NOW).state).toBe(
      "current"
    );
  });

  it("refuses to call a dated-category claim usable with no date", () => {
    // The single most-litigated figure in this domain.
    const result = assessFreshness({ category: "sales_volume" }, NOW);
    expect(result.state).toBe("unknown");
    expect(result.reason).toContain("no as-of date");
    expect(result.blocksHighRisk).toBe(true);
  });

  it("treats a verified transaction as non-decaying but an unverified one as unknown", () => {
    expect(reviewWindowDays("transaction")).toBe(0);
    expect(
      assessFreshness(
        { category: "transaction", asOf: "2019-01-01", verificationStatus: "verified" },
        NOW
      ).state
    ).toBe("current");
    expect(
      assessFreshness(
        { category: "transaction", asOf: "2019-01-01", verificationStatus: "unverified" },
        NOW
      ).state
    ).toBe("unknown");
  });

  it("distinguishes superseded from stale — one needs work, the other does not", () => {
    const superseded = assessFreshness(
      { category: "affiliation", status: "superseded", lastVerifiedAt: "2020-01-01" },
      NOW
    );
    expect(superseded.state).toBe("superseded");
    expect(blocksHighRisk("superseded")).toBe(false);
    expect(blocksHighRisk("stale")).toBe(true);
    expect(blocksHighRisk("unknown")).toBe(true);
  });

  it("prefers an explicit review date over the category default", () => {
    const result = assessFreshness(
      { category: "general", reviewDate: "2026-01-01", lastVerifiedAt: "2026-07-01" },
      NOW
    );
    expect(result.state).toBe("stale");
  });

  it("rolls a set up to its worst member", () => {
    expect(worstFreshness(["current", "nearing_review", "expired"])).toBe("expired");
    expect(worstFreshness(["current", "superseded"])).toBe("superseded");
    expect(worstFreshness([])).toBe("current");
  });
});

// ------------------------------------------------------------ contradictions

function claim(overrides: Partial<ClaimForComparison>): ClaimForComparison {
  return {
    id: "c1",
    key: "k",
    canonicalText: "text",
    value: null,
    category: "general",
    normalizedPredicate: "works_for",
    subjectEntity: "Ana Diaz",
    subjectEntityId: null,
    objectEntityId: null,
    status: "approved",
    privacyStatus: "public",
    asOf: "2026-01-01",
    effectiveDate: null,
    reviewDate: null,
    verificationStatus: "verified",
    lastVerifiedAt: null,
    ...overrides,
  };
}

describe("contradiction detection", () => {
  it("flags two overlapping affiliations as critical", () => {
    const found = detectContradictions(
      [
        claim({ id: "a", canonicalText: "Ana works for Brokerage X" }),
        claim({ id: "b", canonicalText: "Ana works for Brokerage Y" }),
      ],
      NOW
    );
    const conflict = found.find((f) => f.type === "affiliation_conflict");
    expect(conflict).toBeDefined();
    expect(conflict!.severity).toBe("critical");
    expect(conflict!.recommendedResolution).toContain("effective dates");
  });

  it("does not flag affiliations in different years — that is history, not conflict", () => {
    const found = detectContradictions(
      [
        claim({ id: "a", canonicalText: "Ana works for X", asOf: "2023-01-01" }),
        claim({ id: "b", canonicalText: "Ana works for Y", asOf: "2026-01-01" }),
      ],
      NOW
    );
    expect(found.filter((f) => f.type === "affiliation_conflict")).toHaveLength(0);
  });

  it("rates a divergent material value higher than an ordinary one", () => {
    const material = detectContradictions(
      [
        claim({ id: "a", category: "sales_volume", normalizedPredicate: "volume", value: 180 }),
        claim({ id: "b", category: "sales_volume", normalizedPredicate: "volume", value: 210 }),
      ],
      NOW
    );
    expect(material[0]!.type).toBe("value_divergence");
    expect(material[0]!.severity).toBe("high");
    expect(material[0]!.requiresHumanReview).toBe(true);

    const ordinary = detectContradictions(
      [
        claim({ id: "a", category: "service", normalizedPredicate: "count", value: 3 }),
        claim({ id: "b", category: "service", normalizedPredicate: "count", value: 4 }),
      ],
      NOW
    );
    expect(ordinary[0]!.severity).toBe("medium");
  });

  it("does not invent a value conflict between two claims that carry no values", () => {
    const found = detectContradictions(
      [
        claim({ id: "a", normalizedPredicate: "describes", value: null, canonicalText: "one" }),
        claim({ id: "b", normalizedPredicate: "describes", value: null, canonicalText: "two" }),
      ],
      NOW
    );
    expect(found.filter((f) => f.type === "value_divergence")).toHaveLength(0);
  });

  it("flags an expired ranking with no successor, and stays quiet when one exists", () => {
    const orphan = detectContradictions(
      [claim({ id: "a", key: "rank", category: "ranking", asOf: "2024-01-01" })],
      NOW
    );
    expect(orphan.some((f) => f.type === "expired_ranking")).toBe(true);

    const replaced = detectContradictions(
      [
        claim({ id: "a", key: "rank", category: "ranking", asOf: "2024-01-01" }),
        claim({ id: "b", key: "rank", category: "ranking", asOf: "2026-01-01" }),
      ],
      NOW
    );
    expect(replaced.some((f) => f.type === "expired_ranking")).toBe(false);
  });

  it("flags a public claim restating a restricted one", () => {
    const found = detectContradictions(
      [
        claim({ id: "a", privacyStatus: "public", normalizedPredicate: "closed_deal" }),
        claim({ id: "b", privacyStatus: "restricted", normalizedPredicate: "closed_deal" }),
      ],
      NOW
    );
    const leak = found.find((f) => f.type === "privacy_conflict");
    expect(leak).toBeDefined();
    expect(leak!.severity).toBe("high");
  });

  it("flags transposed dates", () => {
    const found = detectContradictions(
      [claim({ id: "a", asOf: "2026-06-01", effectiveDate: "2026-01-01" })],
      NOW
    );
    expect(found.some((f) => f.type === "date_conflict")).toBe(true);
  });

  it("ignores rejected claims — disagreement with a rejection is the system working", () => {
    const found = detectContradictions(
      [
        claim({ id: "a", canonicalText: "Ana works for X" }),
        claim({ id: "b", canonicalText: "Ana works for Y", status: "rejected" }),
      ],
      NOW
    );
    expect(found.filter((f) => f.type === "affiliation_conflict")).toHaveLength(0);
  });
});

// -------------------------------------------------------- extraction guards

function draft(overrides: Partial<ProposedClaimDraft> = {}): ProposedClaimDraft {
  return {
    subject: "JC Luxury",
    predicate: "operates in",
    object: "Jersey City",
    originalWording: "JC Luxury operates in Jersey City.",
    normalizedWording: "JC Luxury operates in Jersey City.",
    category: "market",
    asOf: null,
    value: null,
    confidence: 0.9,
    locator: "page 1",
    ...overrides,
  };
}

describe("claim extraction guards", () => {
  const document = "About us. JC Luxury operates in Jersey City. We closed 40 homes.";

  it("accepts a claim whose quote appears in the document", () => {
    expect(verifyDraft(draft(), document)).toEqual({ ok: true });
  });

  it("rejects a quote the document does not contain — the model wrote it, not found it", () => {
    const result = verifyDraft(
      draft({ originalWording: "JC Luxury is the top firm in Hoboken." }),
      document
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain("does not appear in the source");
  });

  it("tolerates whitespace reflow, because extraction reflows text", () => {
    expect(
      verifyDraft(draft({ originalWording: "JC   Luxury\noperates in Jersey City." }), document)
    ).toEqual({ ok: true });
  });

  it("rejects an invalid date rather than coercing it", () => {
    const result = verifyDraft(draft({ asOf: "last spring" }), document);
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain("not a valid ISO date");
  });

  it("classifies materiality from category and wording, not the model's opinion", () => {
    expect(classifyMateriality({ category: "sales_volume", normalizedWording: "x" })).toBe(
      "high_risk"
    );
    // A superlative is high-risk whatever category it was filed under.
    expect(
      classifyMateriality({
        category: "service",
        normalizedWording: "The leading agent in Hoboken.",
      })
    ).toBe("high_risk");
    expect(
      classifyMateriality({ category: "service", normalizedWording: "Sells homes.", value: 12 })
    ).toBe("material");
    expect(classifyMateriality({ category: "service", normalizedWording: "Sells homes." })).toBe(
      "ordinary"
    );
  });

  it("normalizes categories and predicates to a closed vocabulary", () => {
    expect(normalizeCategory("Sales Volume")).toBe("sales_volume");
    expect(normalizeCategory("nonsense")).toBe("general");
    expect(normalizePredicate("Works For")).toBe("works_for");
  });
});

// ------------------------------------------------------------ token budgets

function item(overrides: Partial<PacketItem>): PacketItem {
  return {
    itemType: "claim",
    itemRef: "x",
    label: "l",
    body: "body",
    priorityClass: PACKET_PRIORITY.optional,
    selectionReason: "test",
    retrievalScore: null,
    tokenCost: 100,
    freshnessStatus: null,
    privacyStatus: null,
    included: true,
    exclusionReason: null,
    ...overrides,
  };
}

describe("token budget", () => {
  it("keeps everything when it fits", () => {
    const result = applyTokenBudget(
      [item({ tokenCost: 100 }), item({ tokenCost: 200 })],
      1000
    );
    expect(result.items.every((i) => i.included)).toBe(true);
    expect(result.tokenCount).toBe(300);
  });

  it("drops optional material and records why, rather than silently", () => {
    const result = applyTokenBudget(
      [
        item({ itemRef: "keep", priorityClass: PACKET_PRIORITY.approvedClaim, tokenCost: 400 }),
        item({ itemRef: "drop", priorityClass: PACKET_PRIORITY.optional, tokenCost: 400 }),
      ],
      500
    );
    const dropped = result.items.find((i) => i.itemRef === "drop")!;
    expect(dropped.included).toBe(false);
    expect(dropped.exclusionReason).toContain("did not fit");
    expect(result.items.find((i) => i.itemRef === "keep")!.included).toBe(true);
  });

  it("NEVER truncates a safety instruction, a claim, or a contradiction to fit", () => {
    // Squeeze the budget until only the mandatory set could possibly survive.
    const mandatory = [
      item({ itemRef: "privacy", priorityClass: PACKET_PRIORITY.safetyInstruction, tokenCost: 100 }),
      item({ itemRef: "claim", priorityClass: PACKET_PRIORITY.approvedClaim, tokenCost: 100 }),
      item({ itemRef: "conflict", priorityClass: PACKET_PRIORITY.contradiction, tokenCost: 100 }),
    ];
    const result = applyTokenBudget(
      [...mandatory, item({ itemRef: "nice-to-have", tokenCost: 5000 })],
      320
    );
    for (const ref of ["privacy", "claim", "conflict"]) {
      expect(result.items.find((i) => i.itemRef === ref)!.included, ref).toBe(true);
    }
    expect(result.items.find((i) => i.itemRef === "nice-to-have")!.included).toBe(false);
  });

  it("refuses to build at all when the mandatory set cannot fit", () => {
    // A packet missing a privacy restriction looks complete. That is worse
    // than no packet, so this must throw rather than degrade.
    expect(() =>
      applyTokenBudget(
        [item({ priorityClass: PACKET_PRIORITY.safetyInstruction, tokenCost: 900 })],
        100
      )
    ).toThrow(/not an option/);
  });

  it("compacts an oversized hot file rather than dropping it whole", () => {
    const result = applyTokenBudget(
      [
        item({ priorityClass: PACKET_PRIORITY.approvedClaim, tokenCost: 100 }),
        item({
          itemRef: "summary",
          itemType: "hot_file",
          priorityClass: PACKET_PRIORITY.strategy,
          tokenCost: 5000,
          body: "word ".repeat(3000),
        }),
      ],
      1000
    );
    const hot = result.items.find((i) => i.itemRef === "summary")!;
    expect(hot.included).toBe(true);
    expect(hot.body).toContain("compacted to fit the token budget");
    expect(hot.exclusionReason).toContain("omitted");
  });

  it("reserves room for workflow state so a large hot file cannot evict it", () => {
    const result = applyTokenBudget(
      [
        item({
          itemRef: "hot",
          itemType: "hot_file",
          priorityClass: PACKET_PRIORITY.strategy,
          tokenCost: 900,
        }),
        item({
          itemRef: "state",
          itemType: "workflow_state",
          priorityClass: PACKET_PRIORITY.workflowState,
          tokenCost: 90,
        }),
      ],
      1000
    );
    // Without the reservation, the hot file (a lower priority number is
    // *higher* priority, and strategy is 7 vs state's 6) is fine — but the
    // reservation is what guarantees state survives a tight budget.
    expect(result.items.find((i) => i.itemRef === "state")!.included).toBe(true);
  });
});

// ------------------------------------------------------------------ packets

describe("packet templates", () => {
  it("declares every template with a budget and an audience", () => {
    for (const template of listPacketTemplates()) {
      expect(template.defaultTokenBudget, template.key).toBeGreaterThan(0);
      expect(["public", "client", "internal"]).toContain(template.audience);
      // `restricted` must not be reachable through any template.
      expect(template.allowedPrivacy).not.toContain("restricted");
    }
  });

  it("keeps the classifier away from transactions and strategy", () => {
    const template = getPacketTemplate("response_classification")!;
    expect(template.excludedCategories).toContain("transaction");
    expect(template.excludedCategories).toContain("sales_volume");
    expect(template.allowsRetrieval).toBe(false);
  });

  it("restricts public drafting to public claims and demands fresh ones", () => {
    const template = getPacketTemplate("content_drafting")!;
    expect(template.allowedPrivacy).toEqual(["public"]);
    expect(template.minFreshness).toBe("nearing_review");
    expect(template.requiresClaims).toBe(true);
    expect(template.requiredInstructionTypes).toContain("prohibited_claim");
  });
});

// ----------------------------------------------------------------- compiler

const selection = (overrides: Partial<PageSelection> = {}): PageSelection => ({
  title: "T",
  summary: "S",
  sections: [],
  dependencies: [],
  freshness: "current",
  structured: {},
  ...overrides,
});

const template = { slug: "x", pageType: "overview" } as PageTemplate;

describe("compiler", () => {
  it("renders deterministically — the same selection always hashes the same", () => {
    const sel = selection({
      sections: [
        {
          key: "a",
          heading: "A",
          body: "one",
          material: false,
          provenance: {
            claimIds: [],
            claimVersionIds: [],
            evidenceIds: [],
            instructionVersionIds: [],
            sourceArtifactIds: [],
          },
        },
      ],
    });
    const first = renderPage(sel);
    expect(renderPage(sel)).toBe(first);
    expect(hashContent(first, sel.structured)).toBe(hashContent(renderPage(sel), sel.structured));
    expect(first).toContain("# T");
    expect(first).toContain("## A");
  });

  it("changes the hash when the structured mirror changes, even if prose does not", () => {
    const body = "# T\n";
    expect(hashContent(body, { n: 1 })).not.toBe(hashContent(body, { n: 2 }));
  });

  it("fails a material section that carries no provenance", () => {
    const result = validateSelection(
      template,
      selection({
        sections: [
          {
            key: "bad",
            heading: "Bad",
            body: "JC Luxury closed $180M.",
            material: true,
            provenance: {
              claimIds: [],
              claimVersionIds: [],
              evidenceIds: [],
              instructionVersionIds: [],
              sourceArtifactIds: [],
            },
          },
        ],
      })
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain("carries no provenance");
  });

  it("fails a section citing a claim the template did not declare", () => {
    // This is the guard that keeps the dependency graph correct, and therefore
    // keeps incremental rebuilds correct.
    const result = validateSelection(
      template,
      selection({
        sections: [
          {
            key: "s",
            heading: "S",
            body: "x",
            material: true,
            provenance: {
              claimIds: ["undeclared-claim"],
              claimVersionIds: [],
              evidenceIds: [],
              instructionVersionIds: [],
              sourceArtifactIds: [],
            },
          },
        ],
        dependencies: [],
      })
    );
    expect(result).toMatchObject({ ok: false });
    expect((result as { reason: string }).reason).toContain("did not declare as a dependency");
  });

  it("passes when the citation is declared", () => {
    expect(
      validateSelection(
        template,
        selection({
          sections: [
            {
              key: "s",
              heading: "S",
              body: "x",
              material: true,
              provenance: {
                claimIds: ["c1"],
                claimVersionIds: [],
                evidenceIds: [],
                instructionVersionIds: [],
                sourceArtifactIds: [],
              },
            },
          ],
          dependencies: [{ type: "claim", id: "c1" }],
        })
      )
    ).toEqual({ ok: true });
  });
});

describe("page template registry", () => {
  it("gives every hot file a declared token budget", () => {
    for (const t of hotFileTemplates()) {
      expect(t.tokenBudget, t.slug).toBeGreaterThan(0);
      expect(HOT_FILE_TOKEN_BUDGETS[t.slug], t.slug).toBe(t.tokenBudget);
    }
  });

  it("has unique slugs and versioned templates", () => {
    const slugs = ALL_PAGE_TEMPLATES.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const t of ALL_PAGE_TEMPLATES) {
      expect(t.templateVersion, t.slug).toMatch(/-v\d+$/);
    }
  });
});

// ------------------------------------------------------------ stale mapping

describe("event to dependency mapping", () => {
  it("maps knowledge events to the object that changed", () => {
    expect(targetsForEvent("claim.approved", { claimId: "c1" })).toEqual([
      { type: "claim", id: "c1" },
    ]);
    expect(targetsForEvent("source.ingested", { sourceArtifactId: "s1" })).toEqual([
      { type: "source_artifact", id: "s1" },
    ]);
    expect(targetsForEvent("instruction.updated", { instructionId: "i1" })).toEqual([
      { type: "instruction", id: "i1" },
    ]);
  });

  it("maps an unrelated event to nothing — that is the correct outcome", () => {
    expect(targetsForEvent("invoice.paid", { invoiceId: "x" })).toEqual([]);
    // And this is what stops the recursion when marking publishes its own event.
    expect(targetsForEvent("wiki.page_marked_stale", { pageId: "p" })).toEqual([]);
  });

  it("maps nothing when the payload lacks the id it would need", () => {
    expect(targetsForEvent("claim.approved", {})).toEqual([]);
  });
});
