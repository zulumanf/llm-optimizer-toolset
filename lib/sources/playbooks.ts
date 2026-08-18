/**
 * Source-type execution playbooks (spec 087): what a team can legitimately DO
 * about each kind of cited source, instead of the generic "get more
 * citations". Keyed by the source taxonomy (lib/sources/classify.ts, v2) and
 * mapped onto the existing acquisition-path enum
 * (lib/citations/constants.ts) so a citation opportunity can start from the
 * right path instead of 'unknown'.
 *
 * Playbooks produce recommended actions for a human to execute — never
 * autonomous publishing. Prohibited everywhere, encoded here so tests can
 * enforce it: fake reviews, persona posting, manufactured recommendations,
 * undisclosed promotional comments, spam.
 */
import type { SourceType } from "@/lib/sources/classify";
import type { AcquisitionPath } from "@/lib/citations/constants";

export const SOURCE_PLAYBOOK_VERSION = "source-playbook-v1";

/** Tactics no playbook may contain, in any phrasing that means them. */
export const PROHIBITED_TACTICS = [
  "fake reviews",
  "persona posting",
  "manufactured recommendations",
  "undisclosed promotional comments",
  "spam",
] as const;

export interface SourcePlaybook {
  sourceType: SourceType;
  label: string;
  /** Legitimate actions, most-leveraged first. Recommended, not executed. */
  actions: string[];
  /** Sensible starting acquisition path for a citation opportunity on this
   * source type; the operator can always override. */
  defaultAcquisitionPath: AcquisitionPath;
  /** True when the client controls the surface — an owned source is fixed by
   * editing, not outreach, and never counts as independent authority. */
  owned: boolean;
}

const PLAYBOOKS: Record<SourceType, SourcePlaybook> = {
  industry_ranking: {
    sourceType: "industry_ranking",
    label: "Industry ranking",
    actions: [
      "Verify eligibility criteria and submission window",
      "Verify a submission exists and is current",
      "Confirm the entity mapping (team vs brokerage vs individual) matches how the ranking lists competitors",
      "Confirm production attribution — the transaction numbers credited to the team",
      "Correct factual data through the publisher's stated process",
    ],
    defaultAcquisitionPath: "industry_association",
    owned: false,
  },
  local_press: {
    sourceType: "local_press",
    label: "Local press",
    actions: [
      "Identify a legitimate newsworthy angle (notable transaction, market data, neighborhood change)",
      "Surface verifiable transaction evidence to support the story",
      "Identify the journalist or editor covering the beat",
      "Prepare evidence-based outreach — data and documents, not adjectives",
    ],
    defaultAcquisitionPath: "local_media",
    owned: false,
  },
  news: {
    sourceType: "news",
    label: "National press",
    actions: [
      "Offer expert commentary on market questions the outlet already covers",
      "Package proprietary market data as a citable story",
      "Respond to journalist source requests in the team's verifiable specialty",
    ],
    defaultAcquisitionPath: "expert_commentary",
    owned: false,
  },
  portal: {
    sourceType: "portal",
    label: "Property portal",
    actions: [
      "Verify profile completeness (photo, bio, service areas, specialties)",
      "Verify entity consistency — same name, team, and brokerage as everywhere else",
      "Confirm transaction history is fully represented",
      "Confirm reviews and reputation sections are complete and current",
    ],
    defaultAcquisitionPath: "directory_listing",
    owned: false,
  },
  review: {
    sourceType: "review",
    label: "Review platform",
    actions: [
      "Claim and complete the profile",
      "Ask genuine past clients for honest reviews through the platform's own flow",
      "Respond to existing reviews, including critical ones",
    ],
    defaultAcquisitionPath: "review_platform_profile",
    owned: false,
  },
  directory: {
    sourceType: "directory",
    label: "Directory",
    actions: [
      "Claim the listing and correct name/address/brokerage data",
      "Align the entity record with the canonical team name and site",
    ],
    defaultAcquisitionPath: "directory_listing",
    owned: false,
  },
  social: {
    sourceType: "social",
    label: "Community / social",
    actions: [
      "Monitor legitimate conversations where the market is being discussed",
      "Identify questions the agent can transparently answer under their own name and disclosure",
    ],
    defaultAcquisitionPath: "community_participation",
    owned: false,
  },
  video: {
    sourceType: "video",
    label: "Video",
    actions: [
      "Publish neighborhood and building walkthroughs under the team's own channel",
      "Pitch guest appearances on established local real-estate channels or podcasts",
    ],
    defaultAcquisitionPath: "podcast_guest",
    owned: false,
  },
  government: {
    sourceType: "government",
    label: "Government / public record",
    actions: [
      "Verify license and registration records are current and consistently named",
      "Ensure public transaction records resolve to the same entity the team markets under",
    ],
    defaultAcquisitionPath: "unknown",
    owned: false,
  },
  client_site: {
    sourceType: "client_site",
    label: "Client-owned site",
    actions: [
      "Publish building authority pages with verifiable transaction evidence",
      "Publish neighborhood authority pages with owned data and local depth",
      "Publish structured entity information (schema, consistent naming, roster)",
      "Verify technical accessibility for AI crawlers",
    ],
    defaultAcquisitionPath: "unknown",
    owned: true,
  },
  brokerage: {
    sourceType: "brokerage",
    label: "Brokerage-owned site",
    actions: [
      "Verify the team's brokerage profile is complete and links the team site",
      "Confirm the brokerage roster names the team consistently with everywhere else",
    ],
    defaultAcquisitionPath: "unknown",
    owned: true,
  },
  other: {
    sourceType: "other",
    label: "Unclassified source",
    actions: [
      "Classify the source before acting — the right move depends on what it is",
    ],
    defaultAcquisitionPath: "unknown",
    owned: false,
  },
};

/** Accepts any string (source_type values arrive from the database);
 * undefined for a value outside the taxonomy — callers skip, never guess. */
export function playbookFor(sourceType: string): SourcePlaybook | undefined {
  return (PLAYBOOKS as Record<string, SourcePlaybook>)[sourceType];
}

export function allPlaybooks(): SourcePlaybook[] {
  return Object.values(PLAYBOOKS);
}
