/**
 * Play templates (spec 026).
 *
 * A play is a known intervention with a declared shape: which gap types it
 * answers, which phase it can run in, what it costs, who does it, and what to
 * re-measure afterwards. Plays are data, not prose, so a plan can be composed
 * by code and every item can point back at the finding that selected it.
 *
 * Two rules the shape enforces:
 *
 * 1. **`requires` is checked against the client's real state.** A play whose
 *    preconditions fail is excluded WITH a reason rather than quietly omitted.
 *    "Claim the Zillow profile" being absent should tell an operator we have no
 *    Zillow data, not leave them wondering.
 *
 * 2. **`measurement` is a movement to observe, never an outcome promised.**
 *    This platform does not guarantee rankings (docs/12), and a plan that
 *    promises a mention rate is a plan that gets quoted back.
 */
import type { GapFinding } from "@/lib/gaps/detect";

export const PLAN_COMPOSER_VERSION = "plan-composer-v1";

export type Phase = "foundation" | "authority" | "compounding";
export type Owner = "operator" | "client" | "shared";

/** Facts about the client that a play may depend on. */
export interface ClientState {
  /** Domains the answers actually cited, with counts. */
  citedDomains: { domain: string; citations: number }[];
  /** True when the client's own domain was cited at least once. */
  ownDomainCited: boolean;
  approvedClaimKeys: string[];
  /** Entities on record, by type — roster, properties, awards. */
  entityCounts: Record<string, number>;
  organicMentionRate: number | null;
  topCompetitorName: string | null;
  topCompetitorRate: number | null;
}

export interface Play {
  key: string;
  title: string;
  /** Which findings make this play relevant. Empty = always relevant. */
  gapTypes: GapFinding["gapType"][];
  phase: Phase;
  effortHours: number;
  owner: Owner;
  measurement: string;
  /**
   * Preconditions. Returns null when satisfied, or the reason it is not —
   * which is stored verbatim on the excluded item.
   */
  requires?: (state: ClientState) => string | null;
  /** Why this play, in this client's specific situation. */
  rationale: (state: ClientState) => string;
}

const has = (state: ClientState, key: string) => state.approvedClaimKeys.includes(key);

export const PLAYS: Play[] = [
  // ---------------------------------------------------------- foundation
  {
    key: "correct_entity_record",
    title: "Make the entity unambiguous in the public record",
    gapTypes: ["entity", "branded_recognition"],
    phase: "foundation",
    effortHours: 6,
    owner: "shared",
    measurement:
      "Re-run the branded prompts; observe whether the assistant describes the correct industry and market.",
    rationale: (s) =>
      `Assistants do not reliably identify this entity: organic mention rate is ${
        s.organicMentionRate === null ? "not measured" : `${(s.organicMentionRate * 100).toFixed(0)}%`
      }. Until the basic facts — industry, market, brokerage, leadership — are stated plainly on pages that get read, no amount of downstream content can be attributed correctly.`,
  },
  {
    key: "publish_brokerage_affiliation",
    title: "State the brokerage affiliation on the owned site",
    gapTypes: ["entity", "branded_recognition"],
    phase: "foundation",
    effortHours: 2,
    owner: "client",
    measurement:
      "Re-run brand-anchored prompts; observe whether brokerage queries surface the team.",
    requires: (s) =>
      has(s, "brokerage")
        ? null
        : "No approved brokerage claim on record — verify the affiliation before publishing it.",
    rationale: () =>
      "The affiliation is verifiable on the brokerage's own site but absent from the owned site, so there is no path from the brand an assistant already trusts to this team.",
  },
  {
    key: "publish_roster_with_credentials",
    title: "Publish the roster with roles and licence numbers",
    gapTypes: ["entity", "branded_recognition"],
    phase: "foundation",
    effortHours: 4,
    owner: "client",
    requires: (s) =>
      (s.entityCounts.person ?? 0) > 0
        ? null
        : "No team members on record — capture the roster first.",
    measurement: "Re-run named-person prompts; observe whether individuals resolve to the team.",
    rationale: (s) =>
      `${s.entityCounts.person ?? 0} named people are on record. Individually attributable, credentialed agents give an assistant something specific to retrieve; an unnamed "team of seasoned agents" gives it nothing.`,
  },
  {
    key: "claim_directory_profiles",
    title: "Claim and complete the profiles that feed retrieval",
    gapTypes: ["citation", "source_target", "entity"],
    phase: "foundation",
    effortHours: 8,
    owner: "shared",
    requires: (s) =>
      s.citedDomains.length > 0
        ? null
        : "No citation data — run a search-enabled measurement before targeting surfaces.",
    measurement:
      "Re-run the discovery set; observe whether any answer cites a profile controlled by the client.",
    rationale: (s) =>
      `The retrieval path runs through ${s.citedDomains
        .slice(0, 3)
        .map((d) => `${d.domain} (${d.citations}×)`)
        .join(", ")}. These are the pages assistants actually read for this category, and a complete profile on them is the cheapest available intervention.`,
  },

  // ------------------------------------------------------------ authority
  {
    key: "evidence_proof_assets",
    title: "Turn transactions and projects into citable proof",
    gapTypes: ["entity", "recommendation", "category_share"],
    phase: "authority",
    effortHours: 12,
    owner: "shared",
    requires: (s) =>
      (s.entityCounts.property ?? 0) > 0
        ? null
        : "No named projects or transactions on record to build proof from.",
    measurement:
      "Re-run recommendation prompts; observe whether answers cite specific projects or volumes.",
    rationale: (s) =>
      `${s.entityCounts.property ?? 0} named developments are on record. Assistants recommend on evidence of work, not on adjectives — specific buildings, unit counts and outcomes are retrievable in a way that "luxury specialist" is not.`,
  },
  {
    key: "own_domain_into_retrieval",
    title: "Get the owned domain into the retrieval path",
    gapTypes: ["citation"],
    phase: "authority",
    effortHours: 16,
    owner: "operator",
    requires: (s) =>
      s.ownDomainCited ? "The owned domain is already cited — this play is unnecessary." : null,
    measurement: "Count citations to the owned domain; currently zero.",
    rationale: () =>
      "Not one answer cited the client's own site. Owned content that is never retrieved cannot influence an answer, however good it is.",
  },
  {
    key: "neighborhood_depth_content",
    title: "Publish neighbourhood-level depth where the category question is asked",
    gapTypes: ["category_share", "entity"],
    phase: "authority",
    effortHours: 20,
    owner: "operator",
    measurement:
      "Re-run per-neighbourhood prompts; observe category share against the current leader.",
    rationale: (s) =>
      `The category conversation happens without them — ${
        s.topCompetitorName ?? "the leader"
      } at ${
        s.topCompetitorRate === null ? "n/a" : `${(s.topCompetitorRate * 100).toFixed(0)}%`
      }. Neighbourhood-specific depth is where a local team can out-specify a national brand.`,
  },
  {
    key: "press_relationships",
    title: "Convert existing press into a repeatable channel",
    gapTypes: ["citation", "source_target"],
    phase: "authority",
    effortHours: 10,
    owner: "shared",
    measurement: "Track citations from publication domains over the next measurement cycle.",
    rationale: () =>
      "Trade and local press already cover this team episodically. A predictable cadence turns one-off coverage into a durable retrieval surface.",
  },

  // --------------------------------------------------------- compounding
  {
    key: "review_velocity",
    title: "Build review velocity on the highest-cited surfaces",
    gapTypes: ["citation", "source_target", "recommendation"],
    phase: "compounding",
    effortHours: 8,
    owner: "client",
    requires: (s) =>
      s.citedDomains.length > 0 ? null : "No citation data to target.",
    measurement:
      "Re-run recommendation prompts; observe whether review-weighted sources begin naming the team.",
    rationale: (s) =>
      `${
        s.citedDomains[0]?.domain ?? "The leading cited surface"
      } weights recent review volume heavily, and it is the single most-cited source in this category. This compounds only after the profiles exist, which is why it sits in the final phase.`,
  },
  {
    key: "remeasure_and_attribute",
    title: "Re-measure against the baseline and attribute what moved",
    gapTypes: [],
    phase: "compounding",
    effortHours: 4,
    owner: "operator",
    measurement:
      "Full re-run of the frozen prompt set on the same instrument; compare against the snapshotted baseline.",
    rationale: () =>
      "The plan is only worth what its measurement proves. Re-running the same frozen prompts on the same model is the only comparison that means anything.",
  },
];

/** Plays whose gap types intersect the findings present, plus the unconditional ones. */
export function relevantPlays(gapTypes: Set<string>): Play[] {
  return PLAYS.filter(
    (play) => play.gapTypes.length === 0 || play.gapTypes.some((t) => gapTypes.has(t))
  );
}
