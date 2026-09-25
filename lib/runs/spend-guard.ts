/**
 * Portfolio spend gates (plan 2.7 + founder sprint authorization 2026-09-15).
 * One implementation for run start (fast refusal) and the executor backstop.
 *
 * Hierarchy: per-call safety (provider adapters) → per-run cap (BUDGET_MAX_USD
 * / run budget) → rolling 24h portfolio pool (DAILY_SPEND_CEILING_USD) →
 * sprint total ceiling (SPRINT_SPEND_CEILING_USD counted from
 * SPRINT_SPEND_AUTHORIZED_AT). The sprint ceiling is a temporary, explicitly
 * authorized envelope; unset means "no sprint envelope" and only the daily
 * pool applies. Nothing here raises a limit — limits come from env, set
 * deliberately per deploy or per operator shell.
 */
import { spendLast24hUsd, spendSinceUsd } from "@/db/runs";
import { DAILY_SPEND_CEILING_USD, SPRINT_SPEND_AUTHORIZED_AT, SPRINT_SPEND_CEILING_USD } from "@/lib/constants";

export interface SpendGate {
  ok: boolean;
  reason: string | null;
  last24hUsd: number;
  dailyCeilingUsd: number;
  sprintUsd: number | null;
  sprintCeilingUsd: number | null;
}

/** Pure decision over the measured spend, so both gates and tests share it. */
export function evaluateSpendGate(input: { last24hUsd: number; dailyCeilingUsd: number; sprintUsd: number | null; sprintCeilingUsd: number | null }): SpendGate {
  const { last24hUsd, dailyCeilingUsd, sprintUsd, sprintCeilingUsd } = input;
  if (last24hUsd >= dailyCeilingUsd) {
    return { ok: false, reason: `portfolio spend ceiling reached ($${last24hUsd.toFixed(2)} of $${dailyCeilingUsd} in 24h) — retry the run once the window clears`, last24hUsd, dailyCeilingUsd, sprintUsd, sprintCeilingUsd };
  }
  if (sprintCeilingUsd !== null && sprintUsd !== null && sprintUsd >= sprintCeilingUsd) {
    return { ok: false, reason: `sprint spend ceiling reached ($${sprintUsd.toFixed(2)} of $${sprintCeilingUsd} since the sprint authorization) — a founder must raise it explicitly`, last24hUsd, dailyCeilingUsd, sprintUsd, sprintCeilingUsd };
  }
  return { ok: true, reason: null, last24hUsd, dailyCeilingUsd, sprintUsd, sprintCeilingUsd };
}

export async function portfolioSpendGate(): Promise<SpendGate> {
  const last24hUsd = await spendLast24hUsd();
  const sprintUsd = SPRINT_SPEND_CEILING_USD !== null && SPRINT_SPEND_AUTHORIZED_AT !== null ? await spendSinceUsd(SPRINT_SPEND_AUTHORIZED_AT) : null;
  return evaluateSpendGate({ last24hUsd, dailyCeilingUsd: DAILY_SPEND_CEILING_USD, sprintUsd, sprintCeilingUsd: SPRINT_SPEND_CEILING_USD !== null && SPRINT_SPEND_AUTHORIZED_AT !== null ? SPRINT_SPEND_CEILING_USD : null });
}
