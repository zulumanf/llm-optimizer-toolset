/**
 * Dispatch policy v2 (founder directive 2026-09-15): outreach collision is
 * controlled per canonical BUYING UNIT, not per brokerage brand.
 *
 *   BUYING UNIT  — the same canonical company, the same provenanced lead
 *                  person in the same market, or the same recipient email.
 *                  At most ONE active cold sequence per unit, ever-contacted
 *                  units are not cold again (recontact rules are unchanged).
 *   BRAND        — Compass / KW / RE/MAX / eXp / Sotheby's … never merges
 *                  independent teams. A brand is not evidence of a shared
 *                  operation.
 *   LOCAL OFFICE — only an evidence-backed registry entry (dated source)
 *                  says two prospects share one tightly managed office; then
 *                  a conservative one-per-office-per-30-days guard applies.
 *                  Unknown relationship = no merge (fail closed only for the
 *                  relationship decision, never a brand-wide block).
 *   CONCENTRATION— a per-day diversification guard on dispatch ORDER: at most
 *                  dailyBrandCap() of one day's new Touch 1 sends from one
 *                  brand. Never a qualification input.
 *
 * Pure functions only; the DB assemblers live in the scripts/service.
 */
import { DAILY_SEND_QUOTA, LOCAL_OFFICE_COLLISION_REGISTRY, dailyBrandCap, type LocalOfficeCollisionEntry } from "@/lib/prospects/constants";

/** Conservative local-office guard: one cold send per evidence-backed office
 * per 30 days. */
export const LOCAL_OFFICE_SEND_CAP_30D = 1;

export interface BuyingUnitFacts {
  prospectId: string;
  companyId: string | null;
  launchId: string;
  /** Normalized lead person, only when provenanced (RealTrends record). */
  leadPersonKey: string | null;
  email: string | null;
}

/** The keys that identify a buying unit. A brokerage brand is deliberately
 * NOT one of them. */
export function buyingUnitKeys(f: BuyingUnitFacts): string[] {
  const keys: string[] = [];
  if (f.companyId) keys.push(`company:${f.companyId}`);
  if (f.leadPersonKey) keys.push(`lead:${f.launchId}:${f.leadPersonKey}`);
  if (f.email) keys.push(`email:${f.email.trim().toLowerCase()}`);
  return keys;
}

export function sameBuyingUnit(a: BuyingUnitFacts, b: BuyingUnitFacts): boolean {
  if (a.prospectId === b.prospectId) return true;
  const ka = new Set(buyingUnitKeys(a));
  return buyingUnitKeys(b).some((k) => ka.has(k));
}

/** The registry-backed local office a prospect belongs to, or null. A
 * national brand name alone never resolves to an office. */
export function localOfficeKeyFor(launchId: string, brokerageKey: string | null, registry: readonly LocalOfficeCollisionEntry[] = LOCAL_OFFICE_COLLISION_REGISTRY): string | null {
  if (!brokerageKey) return null;
  const hit = registry.find((e) => e.launchId === launchId && e.brokerageKey === brokerageKey);
  return hit ? `${launchId}|office:${hit.officeKey}` : null;
}

export interface DispatchCandidate {
  prospectId: string;
  /** Normalized brokerage brand (concentration bucket), null when unknown. */
  brandKey: string | null;
}
export interface DispatchDay {
  day: string;
  /** New Touch 1 capacity left on that day. */
  capacity: number;
  /** Brand sends already committed that day (scheduled or sent). */
  brandUsed?: Record<string, number>;
}
export interface DailyPlan {
  assigned: { prospectId: string; day: string; brandKey: string | null }[];
  /** Fits no offered day yet — still qualified; needs a later day. */
  unassigned: { prospectId: string; reason: "CAPACITY" | "BRAND_CONCENTRATION" }[];
  brandCap: number;
}

/** Assign qualified prospects (already in priority order) to days. Order
 * only: a prospect that does not fit today goes to the next day; nothing
 * here changes qualification. */
export function planDailyBatches(candidates: readonly DispatchCandidate[], days: readonly DispatchDay[], brandCap: number = dailyBrandCap(DAILY_SEND_QUOTA)): DailyPlan {
  const state = days.map((d) => ({ day: d.day, left: Math.max(0, d.capacity), brand: new Map(Object.entries(d.brandUsed ?? {})) }));
  const assigned: DailyPlan["assigned"] = [];
  const unassigned: DailyPlan["unassigned"] = [];
  for (const c of candidates) {
    let placed = false;
    let sawCapacity = false;
    for (const s of state) {
      if (s.left <= 0) continue;
      sawCapacity = true;
      const used = c.brandKey ? (s.brand.get(c.brandKey) ?? 0) : 0;
      if (c.brandKey && used >= brandCap) continue;
      s.left -= 1;
      if (c.brandKey) s.brand.set(c.brandKey, used + 1);
      assigned.push({ prospectId: c.prospectId, day: s.day, brandKey: c.brandKey });
      placed = true;
      break;
    }
    if (!placed) unassigned.push({ prospectId: c.prospectId, reason: sawCapacity ? "BRAND_CONCENTRATION" : "CAPACITY" });
  }
  return { assigned, unassigned, brandCap };
}
