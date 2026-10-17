/**
 * Classifier validation metrics (spec 151 A11), pure.
 *
 * Human truth per pair:
 *   adjudicated  → the adjudication;
 *   unanimous    → ≥ 2 annotators, all agreeing on the field;
 *   single       → exactly one annotator (reported, NOT validated);
 *   disputed     → annotators disagree and no adjudication yet.
 * Precision/recall use only adjudicated + unanimous pairs.
 */
import { wilsonInterval, type Interval } from "@/lib/stats";

export type LabelField = "mentioned" | "recommended";

export interface HumanLabel {
  sameEntity: boolean;
  mentioned: boolean;
  recommended: boolean;
}

export interface PairEvidence {
  itemId: string;
  annotations: HumanLabel[];
  adjudication: HumanLabel | null;
  /** The classifier's current label; null = no classifier-class row. */
  classifier: { mentioned: boolean; recommended: boolean } | null;
}

export type TruthStatus = "adjudicated" | "unanimous" | "single" | "disputed" | "unlabelled";

export function humanTruth(p: PairEvidence, field: LabelField): { status: TruthStatus; value: boolean | null } {
  if (p.adjudication) return { status: "adjudicated", value: p.adjudication[field] };
  if (p.annotations.length === 0) return { status: "unlabelled", value: null };
  const values = new Set(p.annotations.map((a) => a[field]));
  if (values.size > 1) return { status: "disputed", value: null };
  const value = p.annotations[0]![field];
  return p.annotations.length >= 2 ? { status: "unanimous", value } : { status: "single", value };
}

export interface FieldReport {
  field: LabelField;
  validatedPairs: number;
  singleAnnotatorPairs: number;
  disputedPairs: number;
  noClassifierPairs: number;
  truePositive: number;
  falsePositive: number;
  falseNegative: number;
  trueNegative: number;
  precision: number | null;
  precisionInterval: Interval | null;
  recall: number | null;
  recallInterval: Interval | null;
}

export function fieldReport(pairs: PairEvidence[], field: LabelField): FieldReport {
  let tp = 0, fp = 0, fn = 0, tn = 0, single = 0, disputed = 0, noClassifier = 0, validated = 0;
  for (const p of pairs) {
    const truth = humanTruth(p, field);
    if (truth.status === "single") { single += 1; continue; }
    if (truth.status === "disputed") { disputed += 1; continue; }
    if (truth.status === "unlabelled" || truth.value === null) continue;
    if (!p.classifier) { noClassifier += 1; continue; }
    validated += 1;
    const predicted = p.classifier[field];
    if (predicted && truth.value) tp += 1;
    else if (predicted && !truth.value) fp += 1;
    else if (!predicted && truth.value) fn += 1;
    else tn += 1;
  }
  return {
    field,
    validatedPairs: validated,
    singleAnnotatorPairs: single,
    disputedPairs: disputed,
    noClassifierPairs: noClassifier,
    truePositive: tp,
    falsePositive: fp,
    falseNegative: fn,
    trueNegative: tn,
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    precisionInterval: wilsonInterval(tp, tp + fp),
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
    recallInterval: wilsonInterval(tp, tp + fn),
  };
}

/** Cohen's kappa over items with exactly two annotators (null if none). */
export function cohensKappa(pairs: PairEvidence[], field: LabelField): number | null {
  const doubles = pairs.filter((p) => p.annotations.length === 2);
  if (doubles.length === 0) return null;
  let agree = 0, aYes = 0, bYes = 0;
  for (const p of doubles) {
    const [a, b] = p.annotations as [HumanLabel, HumanLabel];
    if (a[field] === b[field]) agree += 1;
    if (a[field]) aYes += 1;
    if (b[field]) bYes += 1;
  }
  const n = doubles.length;
  const po = agree / n;
  const pe = (aYes / n) * (bYes / n) + (1 - aYes / n) * (1 - bYes / n);
  return pe === 1 ? (po === 1 ? 1 : null) : (po - pe) / (1 - pe);
}

/** Deterministic seeded shuffle (Fisher–Yates over a mulberry32 stream). */
export function seededShuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}
