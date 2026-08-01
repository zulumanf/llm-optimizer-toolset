/**
 * Minimal robots.txt compliance for external discovery (spec 027).
 *
 * `lib/knowledge/sources/discover.ts` does not do this, and for the client's
 * own site that is defensible — an operator has the client's permission to read
 * it. Discovery fetches *third-party* sites nobody asked, so the calculus is
 * different: a publisher's stated preference is the only signal we have, and
 * ignoring it while claiming to build an evidence platform would be a poor
 * trade for a handful of pages.
 *
 * Deliberately small. This parses `User-agent`, `Disallow` and `Allow` and
 * nothing else — no wildcards beyond a trailing `*`, no crawl-delay parsing,
 * no sitemap directives. An unparseable or unreachable robots.txt is treated
 * as **allowing** the fetch, matching the RFC's guidance and every mainstream
 * crawler: a 500 on robots.txt is a broken server, not a prohibition.
 */
import { log } from "@/lib/logger";

/** Ours, matching discover.ts so a webmaster sees one identity, not two. */
export const DISCOVERY_USER_AGENT =
  "AvosVisibilityAudit/1.0 (internal AI-visibility audit; contact the operator who scheduled it)";

const ROBOTS_TIMEOUT_MS = 5_000;

export interface RobotsRules {
  /** Path prefixes that may not be fetched. */
  disallow: string[];
  /** Path prefixes explicitly re-allowed inside a broader disallow. */
  allow: string[];
}

/** An empty ruleset — everything permitted. */
const PERMISSIVE: RobotsRules = { disallow: [], allow: [] };

/**
 * Parse robots.txt, keeping the groups that apply to us.
 *
 * Applicable groups are `*` and any exact match on our token. A specific match
 * wins outright: when a site names us, its rules replace the wildcard's rather
 * than merging, which is what the standard specifies and what a webmaster
 * writing a targeted rule expects.
 */
export function parseRobots(body: string, userAgentToken = "avosvisibilityaudit"): RobotsRules {
  const wildcard: RobotsRules = { disallow: [], allow: [] };
  const specific: RobotsRules = { disallow: [], allow: [] };
  let sawSpecific = false;

  // A group is one or more User-agent lines followed by its rules. Consecutive
  // agent lines share the rules that follow them.
  let activeWildcard = false;
  let activeSpecific = false;
  let expectingAgents = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (line.length === 0) continue;

    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const field = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();

    if (field === "user-agent") {
      if (!expectingAgents) {
        activeWildcard = false;
        activeSpecific = false;
        expectingAgents = true;
      }
      const token = value.toLowerCase();
      if (token === "*") activeWildcard = true;
      if (token.includes(userAgentToken)) {
        activeSpecific = true;
        sawSpecific = true;
      }
      continue;
    }

    expectingAgents = false;
    if (field !== "disallow" && field !== "allow") continue;
    // An empty Disallow means "nothing is disallowed" — not "disallow /".
    if (field === "disallow" && value.length === 0) continue;

    for (const [active, target] of [
      [activeWildcard, wildcard],
      [activeSpecific, specific],
    ] as const) {
      if (!active) continue;
      if (field === "disallow") target.disallow.push(value);
      else target.allow.push(value);
    }
  }

  return sawSpecific ? specific : wildcard;
}

/**
 * Whether a path is permitted.
 *
 * Longest matching rule wins, and `Allow` beats `Disallow` at equal length —
 * the convention that lets a site disallow a directory and re-permit one page
 * inside it.
 */
export function isPathAllowed(path: string, rules: RobotsRules): boolean {
  const longest = (patterns: string[]): number => {
    let best = -1;
    for (const pattern of patterns) {
      if (matchesPattern(path, pattern) && pattern.length > best) best = pattern.length;
    }
    return best;
  };
  const disallowed = longest(rules.disallow);
  if (disallowed === -1) return true;
  return longest(rules.allow) >= disallowed;
}

function matchesPattern(path: string, pattern: string): boolean {
  if (pattern.length === 0) return false;
  if (pattern.endsWith("*")) return path.startsWith(pattern.slice(0, -1));
  return path.startsWith(pattern);
}

/**
 * Fetch and evaluate robots.txt for one URL.
 *
 * Results are cached per origin for the life of the caller's map, so a run
 * touching six pages on one publisher asks once.
 */
export async function isFetchAllowed(
  url: string,
  cache: Map<string, RobotsRules>,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const origin = parsed.origin;
  let rules = cache.get(origin);
  if (!rules) {
    rules = await loadRobots(origin, fetchImpl);
    cache.set(origin, rules);
  }
  return isPathAllowed(parsed.pathname, rules);
}

async function loadRobots(origin: string, fetchImpl: typeof fetch): Promise<RobotsRules> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ROBOTS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, {
      headers: { "user-agent": DISCOVERY_USER_AGENT },
      signal: controller.signal,
      redirect: "follow",
    });
    // 4xx means no usable robots policy — the standard reading is "allowed".
    if (!res.ok) return PERMISSIVE;
    const body = await res.text();
    return parseRobots(body);
  } catch (err) {
    // Unreachable robots.txt is a broken server, not a prohibition. Logged so a
    // run that fetched widely on a bad assumption is diagnosable afterwards.
    log("warn", "discovery.robots_unreachable", {
      origin,
      reason: err instanceof Error ? err.message : "unknown",
    });
    return PERMISSIVE;
  } finally {
    clearTimeout(timer);
  }
}
