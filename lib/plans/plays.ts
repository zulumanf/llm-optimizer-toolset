/**
 * Play templates (spec 026).
 *
 * A play is a known intervention with a declared shape: which gap types it
 * answers, which phase it can run in, what it costs, who does it, what to
 * actually do, and what to re-measure. Plays are data, not prose, so a plan can
 * be composed by code and every item can point back at the finding that
 * selected it.
 *
 * Writing rules for the copy here, because this is what a client reads:
 *
 * - `why` is ONE short sentence. If it needs a subordinate clause, it is two
 *   sentences or it is not the point.
 * - `steps` are imperative and concrete. "Add a one-line description to the
 *   homepage" is a step; "improve brand clarity" is a wish.
 * - `measurement` names the observation, not a promised outcome. This platform
 *   does not guarantee rankings (docs/12).
 * - No jargon a client would have to ask about. "Retrieval path" is ours;
 *   "the pages AI reads" is theirs.
 */
import type { GapFinding } from "@/lib/gaps/detect";

export const PLAN_COMPOSER_VERSION = "plan-composer-v2";

export type Phase = "foundation" | "authority" | "compounding";
export type Owner = "operator" | "client" | "shared";

/** Facts about the client that a play may depend on. */
export interface ClientState {
  citedDomains: { domain: string; citations: number }[];
  ownDomainCited: boolean;
  approvedClaimKeys: string[];
  entityCounts: Record<string, number>;
  organicMentionRate: number | null;
  topCompetitorName: string | null;
  topCompetitorRate: number | null;
}

export interface Play {
  key: string;
  title: string;
  gapTypes: GapFinding["gapType"][];
  phase: Phase;
  effortHours: number;
  owner: Owner;
  measurement: string;
  /** Null when satisfied, else the reason — stored verbatim on the item. */
  requires?: (state: ClientState) => string | null;
  /** One short sentence. Why this, for this client, now. */
  why: (state: ClientState) => string;
  /** What to actually do. Imperative, concrete, 2–4 items. */
  steps: (state: ClientState) => string[];
}

const has = (state: ClientState, key: string) => state.approvedClaimKeys.includes(key);
const pct = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 100)}%`);
const topDomains = (state: ClientState, n: number) =>
  state.citedDomains.slice(0, n).map((d) => d.domain);

export const PLAYS: Play[] = [
  // ---------------------------------------------------------- foundation
  {
    key: "correct_entity_record",
    title: "Fix what AI thinks you are",
    gapTypes: ["entity", "branded_recognition"],
    phase: "foundation",
    effortHours: 6,
    owner: "shared",
    why: (s) =>
      `AI assistants mention you in ${pct(s.organicMentionRate)} of relevant answers, and often describe the wrong business.`,
    steps: () => [
      "Add one plain line to the homepage: who you are, what you do, which market.",
      "Use the exact same wording on Google Business Profile, LinkedIn and the brokerage page.",
      "Pick one name and use it everywhere, including the trading name.",
    ],
    measurement: "Ask AI directly who you are. Check it names the right industry and city.",
  },
  {
    key: "publish_brokerage_affiliation",
    title: "Put the brokerage on your own site",
    gapTypes: ["entity", "branded_recognition"],
    phase: "foundation",
    effortHours: 2,
    owner: "client",
    requires: (s) =>
      has(s, "brokerage") ? null : "No verified brokerage on file. Confirm it first.",
    why: () =>
      "The brokerage lists you, but your site never mentions them — so AI can't connect the two.",
    steps: () => [
      "Add the brokerage name to the header or footer of every page.",
      "Link to your team page on the brokerage site.",
      "Add the same link to your Google Business Profile and social bios.",
    ],
    measurement: "Ask AI for that brokerage's agents in your city. Check whether you appear.",
  },
  {
    key: "publish_roster_with_credentials",
    title: "Name your agents publicly",
    gapTypes: ["entity", "branded_recognition"],
    phase: "foundation",
    effortHours: 4,
    owner: "client",
    requires: (s) =>
      (s.entityCounts.person ?? 0) > 0 ? null : "No team members on file yet.",
    why: (s) =>
      `You have ${s.entityCounts.person ?? 0} agents on record. AI can recommend a named person; it can't recommend "our team".`,
    steps: () => [
      "Give every agent a page with name, role, licence number and market.",
      "Say what each person specialises in, in one line.",
      "Keep names identical across your site, the brokerage and LinkedIn.",
    ],
    measurement: "Search each agent's name. Check the results connect them to the team.",
  },
  {
    key: "claim_directory_profiles",
    title: "Claim the profiles AI actually reads",
    gapTypes: ["citation", "source_target", "entity"],
    phase: "foundation",
    effortHours: 8,
    owner: "shared",
    requires: (s) =>
      s.citedDomains.length > 0 ? null : "No citation data yet. Run a search-enabled measurement.",
    why: (s) =>
      `AI answers in your category pull from ${topDomains(s, 2).join(" and ")} more than anywhere else.`,
    steps: (s) => [
      ...topDomains(s, 3).map(
        (domain) => `Claim and fully complete your ${domain} profile — photo, bio, markets, listings.`
      ),
      "Use the same description and market wording as your website.",
    ],
    measurement: "Re-run the same questions. Check whether any answer now cites a page you control.",
  },

  // ------------------------------------------------------------ authority
  {
    key: "evidence_proof_assets",
    title: "Turn your projects into proof",
    gapTypes: ["entity", "recommendation", "category_share"],
    phase: "authority",
    effortHours: 12,
    owner: "shared",
    requires: (s) =>
      (s.entityCounts.property ?? 0) > 0 ? null : "No named projects on file to build from.",
    why: (s) =>
      `You have ${s.entityCounts.property ?? 0} named developments on record. AI recommends on evidence, not adjectives.`,
    steps: () => [
      "Give each development its own page: address, unit count, your role, dates.",
      "Add outcomes you can prove — units leased, timeframes, price achieved.",
      "Link each project page from the relevant neighbourhood page.",
    ],
    measurement: "Ask about new developments in your market. Check whether your projects are named.",
  },
  {
    key: "own_domain_into_retrieval",
    title: "Get your own site cited",
    gapTypes: ["citation"],
    phase: "authority",
    effortHours: 16,
    owner: "operator",
    requires: (s) =>
      s.ownDomainCited ? "Your site is already being cited — this play isn't needed." : null,
    why: () => "Not one AI answer cited your website. Content nobody reads can't influence anything.",
    steps: () => [
      "Publish pages that answer the exact questions buyers ask, in their words.",
      "Add clear headings, dates and author names so pages are easy to quote.",
      "Cover one topic per page rather than one page covering everything.",
    ],
    measurement: "Count answers citing your domain. It is currently zero.",
  },
  {
    key: "neighborhood_depth_content",
    title: "Go deeper on your neighbourhoods",
    gapTypes: ["category_share", "entity"],
    phase: "authority",
    effortHours: 20,
    owner: "operator",
    why: (s) =>
      `${s.topCompetitorName ?? "The leader"} shows up in ${pct(s.topCompetitorRate)} of answers. Local depth is where a local team wins.`,
    steps: () => [
      "Write one substantial page per neighbourhood you genuinely work in.",
      "Include specifics only a local would know — buildings, blocks, timings, fees.",
      "Update each page quarterly and show the date.",
    ],
    measurement: "Ask neighbourhood-level questions. Track how often you appear versus the leader.",
  },
  {
    key: "press_relationships",
    title: "Make press a habit, not an accident",
    gapTypes: ["citation", "source_target"],
    phase: "authority",
    effortHours: 10,
    owner: "shared",
    why: () => "Local press already covers you occasionally. Occasional coverage doesn't compound.",
    steps: () => [
      "List the outlets that already cover your market and name a contact at each.",
      "Send one genuine story per month — a signing, a project, a market read.",
      "Link every piece of coverage from your site.",
    ],
    measurement: "Track how often publication sites appear as sources in AI answers about you.",
  },

  // --------------------------------------------------------- compounding
  {
    key: "review_velocity",
    title: "Build steady review volume",
    gapTypes: ["citation", "source_target", "recommendation"],
    phase: "compounding",
    effortHours: 8,
    owner: "client",
    requires: (s) => (s.citedDomains.length > 0 ? null : "No citation data to target."),
    why: (s) =>
      `${s.citedDomains[0]?.domain ?? "The top-cited site"} weights recent reviews heavily, and it is the most-cited source in your category.`,
    steps: (s) => [
      `Ask every closing client for a review on ${s.citedDomains[0]?.domain ?? "the top site"}.`,
      "Make it one link, sent the same day, with a short suggested prompt.",
      "Reply to every review — recency and responsiveness both count.",
    ],
    measurement: "Track review count and recency on the top-cited sites.",
  },
  {
    key: "remeasure_and_attribute",
    title: "Re-measure and see what moved",
    gapTypes: [],
    phase: "compounding",
    effortHours: 4,
    owner: "operator",
    why: () => "A plan is worth what its measurement proves.",
    steps: () => [
      "Re-run the identical question set on the same model.",
      "Compare against the baseline saved when this plan was built.",
      "Keep what moved the numbers; drop what didn't.",
    ],
    measurement: "Same questions, same model, compared against the saved baseline.",
  },
];

/** Plays whose gap types intersect the findings present, plus unconditional ones. */
export function relevantPlays(gapTypes: Set<string>): Play[] {
  return PLAYS.filter(
    (play) => play.gapTypes.length === 0 || play.gapTypes.some((t) => gapTypes.has(t))
  );
}
