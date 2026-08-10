/**
 * Conflict detection (spec 028). Pure — no I/O, no clock: the caller
 * supplies `today`, because a check is a decision made at a moment and the
 * test suite must be able to hold that moment still.
 *
 * Geography is structural: verdicts come from the containment tree
 * (same / inside / contains / sibling), never from comparing name strings.
 * Every non-clear verdict carries a reason a human can decompose — a
 * verdict the operator cannot explain to a prospect is not one we show.
 */

export const CONFLICT_DETECTOR_VERSION = "conflict-detector-v1";

/** Sibling search stops this many shared-ancestor levels up, so "both are
 * somewhere in the USA" can never manufacture a `possible`. */
const SIBLING_MAX_DEPTH = 2;

/** Containment walks are capped defensively; the tree is operator-built
 * and createMarket refuses cycles, but a pure function trusts no one. */
const MAX_TREE_DEPTH = 20;

export interface MarketNode {
  id: string;
  name: string;
  parentId: string | null;
}

export interface ScopeInput {
  scopeId: string;
  marketId: string;
  /** null = all services */
  serviceCategory: string | null;
  /** null = all segments */
  segment: string | null;
}

export interface AgreementInput {
  agreementId: string;
  projectId: string;
  clientName: string;
  /** reserved = a pending-proposal hold (spec 052): occupies the territory
   * in detection exactly like active; dates still govern the window. */
  status: "active" | "reserved" | "terminated";
  startsOn: string; // YYYY-MM-DD
  endsOn: string | null;
  gracePeriodDays: number;
  terminatedAt: string | null;
  scopes: ScopeInput[];
}

export interface ProspectInput {
  marketId: string;
  serviceCategory: string | null;
  segment: string | null;
}

export type Verdict = "direct" | "partial" | "possible" | "clear";

export type GeoRelation = "same" | "inside" | "contains" | "sibling" | "unrelated";

export interface Conflict {
  verdict: Exclude<Verdict, "clear">;
  agreementId: string;
  projectId: string;
  clientName: string;
  scopeId: string;
  geoRelation: GeoRelation;
  /** The obligation is contractual tail (past ends_on, within grace). */
  gracePeriod: boolean;
  reason: string;
}

export interface DetectionResult {
  detectorVersion: string;
  worstVerdict: Verdict;
  conflicts: Conflict[];
}

const VERDICT_RANK: Record<Verdict, number> = {
  direct: 3,
  partial: 2,
  possible: 1,
  clear: 0,
};

function ancestorsOf(
  marketId: string,
  byId: Map<string, MarketNode>
): string[] {
  const chain: string[] = [];
  let current = byId.get(marketId)?.parentId ?? null;
  for (let depth = 0; current && depth < MAX_TREE_DEPTH; depth += 1) {
    chain.push(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return chain;
}

export function geoRelation(
  a: string,
  b: string,
  markets: MarketNode[]
): GeoRelation {
  if (a === b) return "same";
  const byId = new Map(markets.map((m) => [m.id, m]));
  const ancestorsA = ancestorsOf(a, byId);
  const ancestorsB = ancestorsOf(b, byId);
  if (ancestorsA.includes(b)) return "inside";
  if (ancestorsB.includes(a)) return "contains";
  // Sibling: a shared ancestor within SIBLING_MAX_DEPTH of BOTH nodes.
  const nearA = ancestorsA.slice(0, SIBLING_MAX_DEPTH);
  const nearB = new Set(ancestorsB.slice(0, SIBLING_MAX_DEPTH));
  if (nearA.some((id) => nearB.has(id))) return "sibling";
  return "unrelated";
}

/** Equal, or either side null ("all") — dimension protection overlaps. */
function dimensionOverlaps(a: string | null, b: string | null): boolean {
  return a === null || b === null || a.toLowerCase() === b.toLowerCase();
}

interface ActiveWindow {
  active: boolean;
  gracePeriod: boolean;
}

/** Active = today within [starts_on, effective_end]; effective_end is
 * coalesce(terminated_at, ends_on) + grace days, open-ended when neither
 * bound exists. Dates compare lexicographically in YYYY-MM-DD. */
export function agreementWindow(
  agreement: Pick<
    AgreementInput,
    "startsOn" | "endsOn" | "gracePeriodDays" | "terminatedAt" | "status"
  >,
  today: string
): ActiveWindow {
  if (today < agreement.startsOn) return { active: false, gracePeriod: false };
  const hardEnd =
    agreement.status === "terminated"
      ? (agreement.terminatedAt ?? agreement.endsOn)
      : agreement.endsOn;
  if (hardEnd === null) return { active: true, gracePeriod: false };
  if (today <= hardEnd) return { active: true, gracePeriod: false };
  const graceEnd = addDays(hardEnd, agreement.gracePeriodDays);
  if (today <= graceEnd) return { active: true, gracePeriod: true };
  return { active: false, gracePeriod: false };
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function verdictFor(
  geo: GeoRelation,
  categoryOverlap: boolean,
  segmentOverlap: boolean
): Verdict {
  const bothDimensions = categoryOverlap && segmentOverlap;
  if ((geo === "same" || geo === "inside") && bothDimensions) return "direct";
  if (geo === "contains" && bothDimensions) return "partial";
  // Same territory, one dimension apart — still a conversation to have.
  if (
    (geo === "same" || geo === "inside") &&
    (categoryOverlap || segmentOverlap)
  ) {
    return "partial";
  }
  if (geo === "sibling" && bothDimensions) return "possible";
  return "clear";
}

function describe(
  verdict: Exclude<Verdict, "clear">,
  clientName: string,
  geo: GeoRelation,
  prospectMarket: string,
  scopeMarket: string,
  scope: ScopeInput,
  gracePeriod: boolean
): string {
  const dims = [
    scope.serviceCategory ?? "all services",
    scope.segment ?? "all segments",
  ].join(", ");
  const geoText =
    geo === "same"
      ? `the same market (${scopeMarket})`
      : geo === "inside"
        ? `${prospectMarket}, which is inside protected ${scopeMarket}`
        : geo === "contains"
          ? `${prospectMarket}, which contains protected ${scopeMarket}`
          : `${prospectMarket}, adjacent to protected ${scopeMarket}`;
  const tail = gracePeriod ? " (agreement ended; within grace period)" : "";
  return `${verdict}: ${clientName} holds exclusivity in ${scopeMarket} (${dims}); prospect targets ${geoText}${tail}`;
}

export function detectConflicts(
  prospect: ProspectInput,
  agreements: AgreementInput[],
  markets: MarketNode[],
  today: string
): DetectionResult {
  const nameById = new Map(markets.map((m) => [m.id, m.name]));
  const conflicts: Conflict[] = [];

  for (const agreement of agreements) {
    const window = agreementWindow(agreement, today);
    if (!window.active) continue;
    for (const scope of agreement.scopes) {
      const geo = geoRelation(prospect.marketId, scope.marketId, markets);
      if (geo === "unrelated") continue;
      const categoryOverlap = dimensionOverlaps(
        prospect.serviceCategory,
        scope.serviceCategory
      );
      const segmentOverlap = dimensionOverlaps(prospect.segment, scope.segment);
      const verdict = verdictFor(geo, categoryOverlap, segmentOverlap);
      if (verdict === "clear") continue;
      conflicts.push({
        verdict,
        agreementId: agreement.agreementId,
        projectId: agreement.projectId,
        clientName: agreement.clientName,
        scopeId: scope.scopeId,
        geoRelation: geo,
        gracePeriod: window.gracePeriod,
        reason: describe(
          verdict,
          agreement.clientName,
          geo,
          nameById.get(prospect.marketId) ?? "unknown market",
          nameById.get(scope.marketId) ?? "unknown market",
          scope,
          window.gracePeriod
        ),
      });
    }
  }

  conflicts.sort((a, b) => VERDICT_RANK[b.verdict] - VERDICT_RANK[a.verdict]);
  const worstVerdict = conflicts[0]?.verdict ?? "clear";
  return { detectorVersion: CONFLICT_DETECTOR_VERSION, worstVerdict, conflicts };
}

/** True when adding `parentId` under `childId` would close a cycle — i.e.
 * the proposed parent is the node itself or one of its descendants. */
export function wouldCreateCycle(
  nodeId: string,
  proposedParentId: string,
  markets: MarketNode[]
): boolean {
  if (nodeId === proposedParentId) return true;
  const byId = new Map(markets.map((m) => [m.id, m]));
  return ancestorsOf(proposedParentId, byId).includes(nodeId);
}
