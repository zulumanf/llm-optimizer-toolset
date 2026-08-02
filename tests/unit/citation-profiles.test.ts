/**
 * Spec 036 — citation-profile assembly and the source-gap set difference.
 */
import { describe, expect, it } from "vitest";
import {
  buildProfiles,
  CITATION_PROFILE_VERSION,
} from "@/lib/competitors/citation-profiles";

const SELF = "s0000000-0000-4000-8000-000000000001";
const COMP = "c0000000-0000-4000-8000-000000000001";

describe("buildProfiles", () => {
  const rows = [
    { companyId: SELF, domain: "trusted-reviews.com", citations: 3 },
    { companyId: COMP, domain: "trusted-reviews.com", citations: 2 },
    { companyId: COMP, domain: "rival-fans.net", citations: 5 },
  ];
  const labels = [
    { domain: "trusted-reviews.com", sourceType: "review", relationship: "third_party" },
  ];

  it("assembles per-company domains with labels and computes the gap", () => {
    const profiles = buildProfiles({
      selfId: SELF,
      selfName: "Lumina",
      competitors: [{ companyId: COMP, companyName: "Rival" }],
      rows,
      labels,
    });
    const self = profiles.find((p) => p.isSelf)!;
    const rival = profiles.find((p) => !p.isSelf)!;

    expect(self.domains).toEqual([
      {
        domain: "trusted-reviews.com",
        citations: 3,
        sourceType: "review",
        relationship: "third_party",
      },
    ]);
    expect(self.sourceGap).toEqual([]);

    // Shared domain is not a gap; the rival-only domain is — and its
    // unclassified labels stay null, not guessed.
    expect(rival.sourceGap).toEqual([
      { domain: "rival-fans.net", citations: 5, sourceType: null, relationship: null },
    ]);
  });

  it("a company with no citations gets an empty profile, not an error", () => {
    const profiles = buildProfiles({
      selfId: SELF,
      selfName: "Lumina",
      competitors: [{ companyId: COMP, companyName: "Rival", archived: true }],
      rows: [],
      labels: [],
    });
    expect(profiles).toHaveLength(2);
    expect(profiles[1]).toMatchObject({ domains: [], sourceGap: [], archived: true });
  });

  it("exports a version string", () => {
    expect(CITATION_PROFILE_VERSION).toBe("citation-profile-v1");
  });
});
