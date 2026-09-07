/**
 * Recipient-local business-day arithmetic (spec 127). Business day =
 * Mon–Fri that is not a U.S. federal holiday (observed), evaluated on the
 * calendar date in the given IANA zone. Pure: no I/O, no env.
 */
import { OPERATOR_TIMEZONE } from "@/lib/prospects/intent";

/** IANA zone per U.S. state/district (recipient-local send windows). States
 * spanning zones take the zone of their population majority. */
export const STATE_TIMEZONES: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix", AR: "America/Chicago",
  CA: "America/Los_Angeles", CO: "America/Denver", CT: "America/New_York", DE: "America/New_York",
  DC: "America/New_York", FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Denver", IL: "America/Chicago", IN: "America/New_York", IA: "America/Chicago",
  KS: "America/Chicago", KY: "America/New_York", LA: "America/Chicago", ME: "America/New_York",
  MD: "America/New_York", MA: "America/New_York", MI: "America/New_York", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver", NE: "America/Chicago",
  NV: "America/Los_Angeles", NH: "America/New_York", NJ: "America/New_York", NM: "America/Denver",
  NY: "America/New_York", NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York", RI: "America/New_York",
  SC: "America/New_York", SD: "America/Chicago", TN: "America/New_York", TX: "America/Chicago",
  UT: "America/Denver", VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
};

export function timezoneForState(stateCode: string | null): string {
  return (stateCode && STATE_TIMEZONES[stateCode.toUpperCase()]) || OPERATOR_TIMEZONE;
}

const DAY_MS = 86_400_000;

export interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hourCycle: "h23", weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    formatters.set(tz, f);
  }
  return f;
}
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function wallClock(date: Date, tz: string): WallClock {
  const parts = formatter(tz).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "0";
  return {
    year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
    hour: Number(get("hour")), minute: Number(get("minute")),
    weekday: Math.max(0, WEEKDAYS.indexOf(get("weekday"))),
  };
}

/** The instant at which the zone's wall clock reads the given local time. */
export function zonedInstant(
  year: number, month: number, day: number, hour: number, minute: number, tz: string
): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const w = wallClock(new Date(asUtc), tz);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return new Date(asUtc + (asUtc - wallAsUtc));
}

export const localDateKey = (w: WallClock): string =>
  `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;

function nthWeekdayOfMonth(year: number, month: number, weekday: number, n: number): number {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  return 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
}
function lastWeekdayOfMonth(year: number, month: number, weekday: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return lastDay - ((last - weekday + 7) % 7);
}
function observed(year: number, month: number, day: number): [number, number] {
  const wd = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (wd === 6) return [month, day - 1];
  if (wd === 0) return [month, day + 1];
  return [month, day];
}

/** U.S. federal holidays for a year as `YYYY-MM-DD` keys, with the observed
 * weekday for fixed-date holidays that fall on a weekend. */
export function usFederalHolidays(year: number): Set<string> {
  const key = (m: number, d: number): string =>
    `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const fixed: [number, number][] = [[1, 1], [6, 19], [7, 4], [11, 11], [12, 25]];
  const out = new Set<string>();
  for (const [m, d] of fixed) {
    const [om, od] = observed(year, m, d);
    if (od < 1) out.add(`${year - 1}-12-31`); else out.add(key(om, od));
  }
  out.add(key(1, nthWeekdayOfMonth(year, 1, 1, 3)));   // MLK Day
  out.add(key(2, nthWeekdayOfMonth(year, 2, 1, 3)));   // Presidents' Day
  out.add(key(5, lastWeekdayOfMonth(year, 5, 1)));     // Memorial Day
  out.add(key(9, nthWeekdayOfMonth(year, 9, 1, 1)));   // Labor Day
  out.add(key(10, nthWeekdayOfMonth(year, 10, 1, 2))); // Columbus Day
  out.add(key(11, nthWeekdayOfMonth(year, 11, 4, 4))); // Thanksgiving
  // Dec 31 observed for a Saturday Jan 1 of the following year.
  if (new Date(Date.UTC(year + 1, 0, 1)).getUTCDay() === 6) out.add(key(12, 31));
  return out;
}

export function isUsFederalHoliday(date: Date, tz: string): boolean {
  const w = wallClock(date, tz);
  return usFederalHolidays(w.year).has(localDateKey(w));
}

export function isBusinessDay(date: Date, tz: string): boolean {
  const w = wallClock(date, tz);
  return w.weekday >= 1 && w.weekday <= 5 && !usFederalHolidays(w.year).has(localDateKey(w));
}

/** The local calendar date `n` business days after `from` (same wall-clock
 * time of day), in `tz`. n = 0 returns `from` itself. */
export function addBusinessDays(from: Date, n: number, tz: string): Date {
  let t = from.getTime();
  let counted = 0;
  while (counted < n) {
    t += DAY_MS;
    if (isBusinessDay(new Date(t), tz)) counted += 1;
  }
  return new Date(t);
}

/** FNV-1a over the seed, folded into [min, max] minutes — the same seed
 * always lands on the same minute, different seeds spread across the window. */
export function deterministicOffsetMinutes(seed: string, min: number, max: number): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return min + (h % (max - min + 1));
}

export interface SlotRule {
  tz: string;
  startHour: number;
  offsetMinutes: number;
}

/** First send instant at or after `earliest`: a business-day morning in
 * `tz` at startHour + offset. If today's slot has already passed (or today
 * is not a business day), the next business-day morning. */
export function nextMorningSlot(earliest: Date, rule: SlotRule): Date {
  let t = earliest.getTime();
  for (let i = 0; i < 30; i += 1) {
    const d = new Date(t);
    if (isBusinessDay(d, rule.tz)) {
      const w = wallClock(d, rule.tz);
      const slot = zonedInstant(
        w.year, w.month, w.day, rule.startHour, rule.offsetMinutes, rule.tz
      );
      if (slot.getTime() >= earliest.getTime()) return slot;
    }
    // Advance to the next local midnight.
    const w = wallClock(new Date(t), rule.tz);
    t = zonedInstant(w.year, w.month, w.day, 0, 0, rule.tz).getTime() + DAY_MS + 60_000;
  }
  throw new Error("no business-day slot within 30 days");
}
