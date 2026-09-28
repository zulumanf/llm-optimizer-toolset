/**
 * Send cap ramp (spec 143). The transport cap and the daily Touch 1 quota
 * are a dated schedule: the sender address keeps warming while volume rises
 * to the founder's 40–50 a day. Pure and derived on read — raising, holding
 * or rolling back a step is a diff to SEND_CAP_RAMP, never a config edit.
 */
import { DAILY_SEND_QUOTA, GMAIL_DAILY_SEND_CAP } from "@/lib/prospects/constants";
import { OPERATOR_TIMEZONE } from "@/lib/prospects/intent";

export const SEND_CAP_RAMP_VERSION = "send-cap-ramp-v1+deterministic";

export interface SendCapStep {
  /** First operator-timezone date (YYYY-MM-DD) on which the step applies;
   * null marks the base step that applies before any dated step. */
  effectiveFrom: string | null;
  /** Allowed gmail sends per trailing 24 hours (the send gate's cap). */
  transportCap: number;
  /** The operator's daily Touch 1 commitment; always under the cap so
   * follow-ups and replies keep their headroom (spec 119). */
  touch1Quota: number;
}

const BASE_STEP: SendCapStep = { effectiveFrom: null, transportCap: GMAIL_DAILY_SEND_CAP, touch1Quota: DAILY_SEND_QUOTA };

/** Founder directive 2026-09-28 ("ramp it up"): 25 → 35 → 45 → 50 over two
 * weeks. Ordered by effectiveFrom. */
export const SEND_CAP_RAMP: readonly SendCapStep[] = [
  BASE_STEP,
  { effectiveFrom: "2026-09-30", transportCap: 35, touch1Quota: 30 },
  { effectiveFrom: "2026-10-07", transportCap: 45, touch1Quota: 40 },
  { effectiveFrom: "2026-10-14", transportCap: 50, touch1Quota: 45 },
];

const operatorDate = new Intl.DateTimeFormat("en-CA", { timeZone: OPERATOR_TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit" });

/** The step in force at `at`, judged by the operator-timezone calendar date. */
export function sendCapStep(at: Date = new Date()): SendCapStep {
  const day = operatorDate.format(at);
  let current = BASE_STEP;
  for (const step of SEND_CAP_RAMP) {
    if (step.effectiveFrom !== null && step.effectiveFrom <= day) current = step;
  }
  return current;
}

export function gmailDailySendCap(at: Date = new Date()): number {
  return sendCapStep(at).transportCap;
}

export function dailySendQuota(at: Date = new Date()): number {
  return sendCapStep(at).touch1Quota;
}

/** The step for an operator-timezone calendar day (YYYY-MM-DD), for ledgers
 * and scoreboards that iterate days as strings. */
export function sendCapStepForDay(day: string): SendCapStep {
  let current = BASE_STEP;
  for (const step of SEND_CAP_RAMP) {
    if (step.effectiveFrom !== null && step.effectiveFrom <= day) current = step;
  }
  return current;
}
