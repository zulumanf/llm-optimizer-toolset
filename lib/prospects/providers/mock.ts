/**
 * Fixture-backed mock prospect source (spec 041): deterministic, obviously
 * fictional teams so the discovery flow is fully exercisable keyless in CI.
 * Guarded out of production by the registry, exactly like the mock AI
 * provider.
 */
import type {
  ProspectDiscoveryInput,
  ProspectSourceAdapter,
  RawProspect,
  SourceRecord,
} from "@/lib/prospects/providers/types";

/** Fixed retrieval date: fixtures are fixtures, not fresh observations. */
const FIXTURE_RETRIEVED_AT = "2026-08-01T00:00:00.000Z";

const FIXTURE_TEAMS: RawProspect[] = [
  {
    businessName: "Harborlight Realty Team",
    prospectType: "team",
    teamLeader: "Dana Harbor",
    brokerageAffiliation: "Compass",
    website: "https://harborlightrealty.example.com",
    email: "hello@harborlightrealty.example.com",
    specialties: ["luxury condos"],
    priceSegment: "luxury",
  },
  {
    businessName: "Meridian Rowhouse Group",
    prospectType: "team",
    teamLeader: "Ory Meridian",
    brokerageAffiliation: "Corcoran Sawyer Smith",
    website: "https://meridianrowhouse.example.com",
    specialties: ["brownstones", "townhouses"],
  },
  {
    businessName: "Bluepeak Property Advisors",
    prospectType: "individual_agent",
    teamLeader: "Sam Bluepeak",
    website: "https://bluepeak.example.com",
    phone: "+1 555 0100",
    specialties: ["investment properties"],
  },
];

export const mockProspectSource: ProspectSourceAdapter = {
  id: "mock",
  async discoverProspects(
    input: ProspectDiscoveryInput
  ): Promise<SourceRecord<RawProspect>[]> {
    const limit = Math.min(input.limit ?? FIXTURE_TEAMS.length, FIXTURE_TEAMS.length);
    return FIXTURE_TEAMS.slice(0, limit).map((team) => ({
      data: {
        ...team,
        neighborhoods: input.segment ? [input.segment] : team.neighborhoods,
      },
      provider: "mock",
      sourceType: "fixture",
      sourceUrl: `https://rankings.example.com/${encodeURIComponent(input.marketName)}`,
      retrievedAt: FIXTURE_RETRIEVED_AT,
      confidence: 0.9,
      provenance: "publicly_sourced",
    }));
  },
  async validateConfiguration() {
    return { ok: true, detail: "fixture adapter, no configuration" };
  },
};
