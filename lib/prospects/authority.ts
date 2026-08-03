/**
 * Local-authority profile (spec 038): a 0–100 score over a prospect's
 * authority signals, derived on read — never stored — with every point
 * traceable to the signal ids behind it.
 *
 * Rules that keep the number honest:
 * - Max per kind, not sum: five press mentions score once. Stuffing a
 *   component with near-duplicate signals cannot inflate the score.
 * - Global-scope evidence is EXCLUDED with a reason, not discounted:
 *   nationwide volume is not local authority (target pipeline req. 11).
 * - Provenance discounts the points: a verified fact outranks an estimate.
 * - No signals → null, never zero. Zero would read as "measured: none".
 */
import type { AuthoritySignalKind, ProvenanceLabel } from "@/lib/prospects/constants";

export const AUTHORITY_PROFILE_VERSION = "authority-v1";

export interface AuthoritySignalInput {
  id: string;
  kind: AuthoritySignalKind;
  provenance: ProvenanceLabel;
  scope: "local" | "global";
  /** Optional operator-recorded 0–1 confidence on the fact itself. */
  confidence: number | null;
}

export interface AuthorityComponent {
  key: string;
  label: string;
  points: number;
  maxPoints: number;
  signalIds: string[];
}

export interface AuthorityProfile {
  version: typeof AUTHORITY_PROFILE_VERSION;
  /** 0–100; null when no signal counted. */
  score: number | null;
  /** 0–1 data confidence; null when no signal counted. */
  confidence: number | null;
  components: AuthorityComponent[];
  excluded: { signalId: string; reason: string }[];
}

export const PROVENANCE_FACTORS: Record<ProvenanceLabel, number> = {
  verified: 1.0,
  publicly_sourced: 0.85,
  manual: 0.6,
  estimated: 0.4,
  ai_inferred: 0.25,
};

interface ComponentSpec {
  key: string;
  label: string;
  maxPoints: number;
  kindPoints: Partial<Record<AuthoritySignalKind, number>>;
}

/** Max points sum to 100. Kind points within a component may exceed its cap —
 * the cap is applied after summing, so a broad evidence base saturates. */
const COMPONENTS: ComponentSpec[] = [
  {
    key: "sales",
    label: "Sales evidence",
    maxPoints: 30,
    kindPoints: {
      transaction_volume: 12,
      transaction_count: 8,
      avg_deal_value: 4,
      notable_sale: 3,
      notable_listing: 3,
    },
  },
  {
    key: "recognition",
    label: "Market recognition",
    maxPoints: 25,
    kindPoints: { ranking: 15, award: 10 },
  },
  {
    key: "reputation",
    label: "Reputation & tenure",
    maxPoints: 20,
    kindPoints: { review_footprint: 12, years_in_market: 4, team_size: 4 },
  },
  {
    key: "media",
    label: "Media & content",
    maxPoints: 15,
    kindPoints: { press_mention: 8, market_report: 4, video_content: 2, speaking: 1 },
  },
  {
    key: "specialization",
    label: "Specialization",
    maxPoints: 10,
    kindPoints: { specialization: 10 },
  },
];

export function authorityProfile(signals: AuthoritySignalInput[]): AuthorityProfile {
  const excluded: { signalId: string; reason: string }[] = [];
  const counted: AuthoritySignalInput[] = [];
  for (const signal of signals) {
    if (signal.scope === "global") {
      excluded.push({
        signalId: signal.id,
        reason: "Global-scope evidence — shown for context, not counted as local authority.",
      });
    } else if (signal.kind === "other") {
      excluded.push({
        signalId: signal.id,
        reason: "Unclassified evidence earns display, not points.",
      });
    } else {
      counted.push(signal);
    }
  }

  const components: AuthorityComponent[] = COMPONENTS.map((spec) => {
    // Best effective signal per kind — max, not sum.
    const bestByKind = new Map<AuthoritySignalKind, { points: number; ids: string[] }>();
    for (const signal of counted) {
      const kindPoints = spec.kindPoints[signal.kind];
      if (kindPoints === undefined) continue;
      const effective =
        kindPoints * PROVENANCE_FACTORS[signal.provenance] * (signal.confidence ?? 1);
      const best = bestByKind.get(signal.kind);
      if (!best) {
        bestByKind.set(signal.kind, { points: effective, ids: [signal.id] });
      } else {
        best.points = Math.max(best.points, effective);
        best.ids.push(signal.id);
      }
    }
    const raw = [...bestByKind.values()].reduce((acc, k) => acc + k.points, 0);
    return {
      key: spec.key,
      label: spec.label,
      points: Math.min(raw, spec.maxPoints),
      maxPoints: spec.maxPoints,
      signalIds: [...bestByKind.values()].flatMap((k) => k.ids),
    };
  });

  const countedIds = new Set(components.flatMap((c) => c.signalIds));
  if (countedIds.size === 0) {
    return {
      version: AUTHORITY_PROFILE_VERSION,
      score: null,
      confidence: null,
      components,
      excluded,
    };
  }

  const score = components.reduce((acc, c) => acc + c.points, 0);
  const contributing = counted.filter((s) => countedIds.has(s.id));
  const meanProvenance =
    contributing.reduce((acc, s) => acc + PROVENANCE_FACTORS[s.provenance], 0) /
    contributing.length;
  const coverage =
    components.filter((c) => c.signalIds.length > 0).length / COMPONENTS.length;
  return {
    version: AUTHORITY_PROFILE_VERSION,
    score,
    confidence: 0.5 * meanProvenance + 0.5 * coverage,
    components,
    excluded,
  };
}
