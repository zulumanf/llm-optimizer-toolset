/**
 * A small, dependency-free cron evaluator with real IANA timezone support.
 *
 * Why not a library: the whole surface we need is "parse five fields, tell me
 * the next occurrence in a named timezone". That is ~150 lines and zero
 * supply-chain risk, and the DST behaviour is the part that actually matters
 * for a client-facing schedule — a 09:00 America/New_York report must stay at
 * 09:00 across the March and November boundaries, which naive UTC arithmetic
 * silently breaks.
 *
 * Supported syntax: five fields (minute hour day-of-month month day-of-week),
 * each `*`, a number, a `a-b` range, an `a,b,c` list, or a `*\/n` / `a-b/n`
 * step. Deliberately unsupported: `L`, `W`, `#`, `?`, seconds, and named
 * shorthands. Unsupported syntax is REJECTED at parse time — a schedule that
 * silently mis-fires is worse than one that refuses to be created.
 */
import { ClassifiedError } from "@/lib/errors";

export interface CronFields {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  /** True when both day-of-month and day-of-week are restricted (cron ORs them). */
  dayOr: boolean;
}

interface FieldRange {
  min: number;
  max: number;
  name: string;
}

const FIELD_RANGES: FieldRange[] = [
  { min: 0, max: 59, name: "minute" },
  { min: 0, max: 23, name: "hour" },
  { min: 1, max: 31, name: "day-of-month" },
  { min: 1, max: 12, name: "month" },
  { min: 0, max: 6, name: "day-of-week" },
];

function parseField(raw: string, range: FieldRange): number[] {
  const values = new Set<number>();
  for (const part of raw.split(",")) {
    const [spec, stepRaw] = part.split("/");
    if (spec === undefined || spec === "") {
      throw new ClassifiedError("validation", `Invalid ${range.name} field: "${raw}"`);
    }
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) {
      throw new ClassifiedError("validation", `Invalid step in ${range.name} field: "${part}"`);
    }

    let start: number;
    let end: number;
    if (spec === "*") {
      start = range.min;
      end = range.max;
    } else if (spec.includes("-")) {
      const [a, b] = spec.split("-");
      start = Number(a);
      end = Number(b);
    } else {
      start = Number(spec);
      end = stepRaw === undefined ? start : range.max;
    }

    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new ClassifiedError(
        "validation",
        `Unsupported ${range.name} syntax "${part}". Only *, n, a-b and steps are supported.`
      );
    }
    if (start < range.min || end > range.max || start > end) {
      throw new ClassifiedError(
        "validation",
        `${range.name} value out of range in "${part}" (expected ${range.min}-${range.max}).`
      );
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  return [...values].sort((a, b) => a - b);
}

export function parseCron(expression: string): CronFields {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ClassifiedError(
      "validation",
      `Cron expression must have exactly 5 fields, got ${fields.length}: "${expression}"`
    );
  }
  if (/[LW#?]/.test(expression)) {
    throw new ClassifiedError(
      "validation",
      `Unsupported cron syntax (L, W, # and ? are not implemented): "${expression}"`
    );
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  return {
    minutes: parseField(minute, FIELD_RANGES[0]!),
    hours: parseField(hour, FIELD_RANGES[1]!),
    daysOfMonth: parseField(dom, FIELD_RANGES[2]!),
    months: parseField(month, FIELD_RANGES[3]!),
    daysOfWeek: parseField(dow, FIELD_RANGES[4]!),
    // Standard cron semantics: when both day fields are restricted, a match on
    // either one fires. Only one restricted means that one governs.
    dayOr: dom !== "*" && dow !== "*",
  };
}

// ------------------------------------------------------------- timezone

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timezone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new ClassifiedError("validation", `Unknown timezone "${timezone}".`);
    }
    formatterCache.set(timezone, formatter);
  }
  return formatter;
}

export function zonedParts(date: Date, timezone: string): ZonedParts {
  const parts = formatterFor(timezone).formatToParts(date);
  const values: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return {
    year: values.year!,
    month: values.month!,
    day: values.day!,
    hour: values.hour! % 24,
    minute: values.minute!,
  };
}

/** Offset, in ms, that must be subtracted from a wall-clock instant to get UTC. */
function offsetMs(date: Date, timezone: string): number {
  const parts = zonedParts(date, timezone);
  const secondsPart = formatterFor(timezone)
    .formatToParts(date)
    .find((p) => p.type === "second");
  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    Number(secondsPart?.value ?? 0)
  );
  return asIfUtc - date.getTime();
}

/**
 * Convert a wall-clock time in `timezone` to the UTC instant.
 *
 * Two convergence passes handle DST: the first uses the offset at the naive
 * guess, the second re-reads the offset at the corrected instant. A wall-clock
 * time that does not exist (the spring-forward gap) resolves to the instant
 * just after the transition, which is the conventional and safe choice.
 */
export function utcFromZoned(parts: ZonedParts, timezone: string): Date {
  const guess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
  let ts = guess - offsetMs(new Date(guess), timezone);
  ts = guess - offsetMs(new Date(ts), timezone);
  return new Date(ts);
}

function dayOfWeek(year: number, month: number, day: number): number {
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayMatches(fields: CronFields, year: number, month: number, day: number): boolean {
  const domMatch = fields.daysOfMonth.includes(day);
  const dowMatch = fields.daysOfWeek.includes(dayOfWeek(year, month, day));
  return fields.dayOr ? domMatch || dowMatch : domMatch && dowMatch;
}

/** How far ahead we are willing to search before declaring an expression dead. */
const MAX_SEARCH_DAYS = 1500;

/**
 * The first occurrence strictly after `after`, in `timezone`.
 * Returns null when the expression cannot fire within the search horizon
 * (e.g. `0 0 30 2 *` — February 30th).
 */
export function nextOccurrence(
  fields: CronFields,
  after: Date,
  timezone: string
): Date | null {
  // Start one minute past `after` so an occurrence exactly at `after` is not
  // returned twice by successive calls.
  const from = new Date(Math.floor(after.getTime() / 60_000) * 60_000 + 60_000);
  const start = zonedParts(from, timezone);

  let { year, month, day } = start;
  for (let dayIndex = 0; dayIndex < MAX_SEARCH_DAYS; dayIndex += 1) {
    if (fields.months.includes(month) && dayMatches(fields, year, month, day)) {
      for (const hour of fields.hours) {
        for (const minute of fields.minutes) {
          const candidate = utcFromZoned({ year, month, day, hour, minute }, timezone);
          if (candidate.getTime() >= from.getTime()) return candidate;
        }
      }
    }
    day += 1;
    if (day > daysInMonth(year, month)) {
      day = 1;
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
  }
  return null;
}

/**
 * Every occurrence in `(after, until]`, bounded. Used for missed-run catch-up:
 * a dispatcher that was down for six hours needs to know which windows it
 * missed, not just the next one.
 */
export function occurrencesBetween(
  fields: CronFields,
  after: Date,
  until: Date,
  timezone: string,
  limit = 500
): Date[] {
  const result: Date[] = [];
  let cursor = after;
  while (result.length < limit) {
    const next = nextOccurrence(fields, cursor, timezone);
    if (!next || next.getTime() > until.getTime()) break;
    result.push(next);
    cursor = next;
  }
  return result;
}

/** The fire key for a scheduled window: its identity, not the moment it ran. */
export function fireKeyForSlot(slot: Date): string {
  return slot.toISOString().slice(0, 19) + "Z";
}
