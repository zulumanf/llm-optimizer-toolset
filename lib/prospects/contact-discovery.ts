/**
 * Contact discovery cascade (2026-09-14): the pure layer that turns a
 * prequalified candidate into a deterministic search for its decision-
 * maker's PUBLIC email — cheap paths first, strict verification always.
 *
 * DISCOVERY is broad (own domain → brokerage profile → search-discovered
 * page → rendered page → structured data). VERIFICATION is one rule and
 * lives in lib/prospects/contact-verify.ts (the literal address must
 * appear on a fetched public page, plain or Cloudflare-encoded). Nothing
 * here guesses, patterns or infers an address; a search snippet is only
 * ever a pointer to a page that must then be fetched and verified.
 *
 * Failure is granular (ContactFailure) and a fetch failure is never
 * "no contact": HOST_BLOCKED and JS_RENDER_REQUIRED route to the next
 * tier; NO_CONTACT_FOUND requires every applicable tier to have been
 * tried. Research is cached per candidate so a failed path is not retried
 * blindly. The DB assembler is scripts/contact-discover.ts.
 */
import { decodeCloudflareEmails } from "@/lib/prospects/contact-verify";
import { isGenericEmail } from "@/lib/prospects/t1-cohort";

export const CONTACT_DISCOVERY_VERSION = "contact-discovery-v1";

// ------------------------------------------------------------ extraction

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|css|js)$/i;

export function normalizeEmail(raw: string): string | null {
  const s = raw.trim().replace(/^mailto:/i, "").split("?")[0]!.toLowerCase();
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) return null;
  if (IMAGE_EXT.test(s) || /example\.com$|sentry|wixpress|\.png@|@[0-9.]+$/.test(s)) return null;
  return s;
}

export type EmailSourceMethod = "mailto" | "visible_text" | "json_ld" | "cloudflare_encoded";
export interface ExtractedEmail { email: string; method: EmailSourceMethod }

/** Deterministic extraction from page HTML: mailto links, JSON-LD email
 * fields, visible/literal text, Cloudflare-encoded addresses. Ordered by
 * strength of binding (mailto and JSON-LD name the address as a contact). */
export function extractEmails(html: string): ExtractedEmail[] {
  const out = new Map<string, ExtractedEmail>();
  const add = (raw: string, method: EmailSourceMethod) => {
    const e = normalizeEmail(raw);
    if (e && !out.has(e)) out.set(e, { email: e, method });
  };
  for (const m of html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)) add(m[1]!, "mailto");
  for (const block of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const m of block[1]!.matchAll(/"email"\s*:\s*"([^"]+)"/g)) add(m[1]!, "json_ld");
  }
  for (const e of decodeCloudflareEmails(html)) add(e, "cloudflare_encoded");
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/&#64;|&commat;/g, "@").replace(/\s*\[at\]\s*|\s*\(at\)\s*/gi, "@").replace(/\s*\[dot\]\s*|\s*\(dot\)\s*/gi, ".");
  for (const m of text.matchAll(EMAIL_RE)) add(m[0], "visible_text");
  return [...out.values()];
}

// ------------------------------------------------------- page classification

export type FetchOutcome = { kind: "ok"; status: number; html: string } | { kind: "http_error"; status: number } | { kind: "network_error"; message: string };

export type ContactFailure =
  | "OFFICIAL_PAGE_NO_EMAIL"
  | "HOST_BLOCKED"
  | "JS_RENDER_REQUIRED"
  | "PROFILE_NOT_FOUND"
  | "IDENTITY_AMBIGUOUS"
  | "GENERIC_ONLY"
  | "SEARCH_DISCOVERED_UNVERIFIED"
  | "NO_AUTHORITATIVE_SOURCE"
  | "TEMPORARY_FETCH_ERROR";

/** A page that returned a document but no usable body: a JS shell (tiny
 * body, root div, bundles) or a bot challenge. Routes to the renderer. */
export function looksLikeJsShell(html: string): boolean {
  const textLen = html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().length;
  const hasRoot = /<div id="(root|__next|app)"/i.test(html) || /__NEXT_DATA__|window\.__INITIAL_STATE__/.test(html);
  const challenge = /cf-challenge|Just a moment|Attention Required|Access Denied|Please enable JavaScript/i.test(html);
  return challenge || (hasRoot && textLen < 400) || textLen < 120;
}

export function classifyFetch(o: FetchOutcome): ContactFailure | null {
  if (o.kind === "network_error") return "TEMPORARY_FETCH_ERROR";
  if (o.kind === "http_error") {
    if (o.status === 403 || o.status === 401 || o.status === 429 || o.status === 503) return "HOST_BLOCKED";
    if (o.status === 404 || o.status === 410) return "PROFILE_NOT_FOUND";
    return o.status >= 500 ? "TEMPORARY_FETCH_ERROR" : "HOST_BLOCKED";
  }
  return looksLikeJsShell(o.html) ? "JS_RENDER_REQUIRED" : null;
}

// ------------------------------------------------------------ candidate URLs

export type SourceType = "own_domain" | "brokerage_profile" | "search_discovered_page" | "rendered_page" | "alternate_authoritative";

export interface DiscoveryCandidate {
  candidateId: string;
  entityName: string;
  entityType: "team" | "individual";
  decisionMaker: string | null;
  brokerage: string | null;
  city: string;
  state: string;
  website: string | null;
}

const CONTACT_PATHS = ["", "/contact", "/contact-us", "/about", "/about-us", "/team", "/our-team", "/agents", "/meet-the-team"];

export function ownDomainUrls(website: string): string[] {
  const base = website.replace(/\/+$/, "");
  return CONTACT_PATHS.map((p) => `${base}${p}`);
}

/** Deterministic search queries from the candidate's own facts: the person
 * or team name + market, then brokerage-scoped variants. No model. */
export function searchQueries(c: DiscoveryCandidate): string[] {
  const who = c.decisionMaker ?? c.entityName;
  const q: string[] = [
    `"${who}" ${c.city} ${c.state} real estate email`,
    `"${who}" "${c.city}" realtor contact`,
  ];
  if (c.decisionMaker && c.entityType === "team") q.push(`"${c.entityName}" ${c.city} real estate team contact`);
  if (c.brokerage) q.push(`"${who}" "${c.brokerage.split(",")[0]!.trim()}"`);
  return q;
}

/** Hosts whose pages are public but not authoritative for a person's
 * current address (press-release wires, agent-profile aggregators): a hit
 * there is a pointer for human review, never an automatic FOUND. */
export const REVIEW_ONLY_HOSTS = /newswire\.com|prnewswire|prweb|einpresswire|globenewswire|businesswire|residential\.com|fastexpert|homelight|realestateagents\.com|agentpronto|upnest|ratemyagent|realtyna|top-agents|expertise\.com|thumbtack|nextdoor|alignable|manta\.com|dnb\.com|buzzfile|crunchbase|opencorporates/i;

const SKIP_HOSTS = /zillow\.com|realtor\.com|homes\.com|redfin\.com\/real-estate-agents|trulia\.com|linkedin\.com|facebook\.com|instagram\.com|youtube\.com|yelp\.com|zoominfo|rocketreach|apollo\.io|signalhire|contactout|wiza|lusha|hunter\.io|snov|leadiq|mapquest|yellowpages|bbb\.org|indeed|glassdoor|pinterest|tiktok|twitter\.com|x\.com|wikipedia|duckduckgo|bing\.com|google\.|brave\.com/i;

/** Absolute http(s) links from a search-result page, de-duplicated, with
 * aggregator / enrichment-database / social hosts removed: those are not
 * authoritative sources under contact policy. */
export function extractResultLinks(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/href="(https?:\/\/[^"#]+)"/gi)) {
    let url = m[1]!;
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]!);
    url = url.replace(/&amp;/g, "&");
    if (SKIP_HOSTS.test(url)) continue;
    const key = url.replace(/\/$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(url);
  }
  return out;
}

/** Rank discovered links: the person's or team's own tokens in the host or
 * path first, then the brokerage's; generic pages last. */
export function rankResultLinks(links: string[], c: DiscoveryCandidate): string[] {
  const tokens = (s: string | null) => (s ?? "").toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !["the", "and", "group", "team", "real", "estate", "realty", "homes", "llc", "inc"].includes(t));
  const who = tokens(c.decisionMaker ?? c.entityName);
  const team = tokens(c.entityName);
  const brok = tokens(c.brokerage);
  const score = (u: string) => {
    const l = u.toLowerCase();
    let s = 0;
    for (const t of who) if (l.includes(t)) s += 3;
    for (const t of team) if (l.includes(t)) s += 2;
    for (const t of brok) if (l.includes(t)) s += 1;
    if (/contact|about|team|agent|profile|bio/.test(l)) s += 1;
    return s;
  };
  return [...links].sort((a, b) => score(b) - score(a)).filter((u) => score(u) > 0);
}

// -------------------------------------------------------------- binding

export type DiscoveryStatus = "FOUND" | "GENERIC_ONLY" | "DISCOVERED_UNVERIFIED" | "NOT_FOUND" | "REVIEW";

export interface BoundContact {
  candidateId: string;
  person: string;
  role: "team lead" | "agent" | "unknown";
  email: string;
  sourceUrl: string;
  sourceType: SourceType;
  method: EmailSourceMethod;
  /** True only when the literal address was read from a fetched page. */
  literalOnSource: boolean;
  identityMatch: boolean;
  discoveredAt: string;
}

const FREE_MAIL = /^(gmail|yahoo|hotmail|aol|outlook|icloud|me|live|msn|protonmail)\.com$/i;
const GENERIC_NAME_WORDS = new Set(["the", "and", "group", "team", "real", "estate", "realty", "homes", "home", "llc", "inc", "associates", "partners", "properties", "property", "luxury", "international", "co", "company", "sales", "brokers", "brokerage", "realtors", "realtor", "agents", "agent", "of", "at", "in"]);
const personTokens = (name: string): string[] => name.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter((t) => t.length > 2 && !GENERIC_NAME_WORDS.has(t));

/** Does an address bind to the decision maker or team? Only DISTINCTIVE
 * name tokens count ("group", "realty", "homes" never bind), matched in the
 * local part or the domain, or the person's full name printed on the page.
 * Domain-pattern guesses never enter here: the address must already have
 * been extracted from the page. */
export function bindsToPerson(email: string, person: string, pageHtml: string): boolean {
  const [local, domain] = email.toLowerCase().split("@") as [string, string];
  const toks = personTokens(person);
  if (toks.length === 0) return false;
  const last = toks[toks.length - 1]!;
  const first = toks[0]!;
  const distinctive = toks.filter((t) => t.length >= 4);
  const text = pageHtml.replace(/<[^>]+>/g, " ");
  const pageNamesPerson = toks.length >= 2 && new RegExp(`\\b${first}\\s+(\\w+\\s+)?${last}\\b`, "i").test(text);
  // The address itself must carry the person: a distinctive token (surname
  // or team word) in the local part, initial+surname, or the entity's own
  // domain. A first name alone binds only when the page also prints the
  // full name (a roster printing the lead's name next to ANOTHER agent's
  // mailto never binds — that mailto carries the other agent's name).
  const surnameHit = distinctive.filter((t) => t !== first).some((t) => local.includes(t));
  const initialSurname = first.length >= 3 && last.length >= 3 && local.startsWith(first[0]!) && local.includes(last);
  const firstOnly = first.length >= 4 && local.includes(first) && pageNamesPerson && !FREE_MAIL.test(domain);
  const domainHit = distinctive.some((t) => domain.includes(t));
  return surnameHit || initialSurname || firstOnly || domainHit;
}

/** Choose the decision-maker address from a page's extracted emails:
 * direct-to-person first, generic inboxes reported separately, everything
 * else (another agent's address) never bound to this candidate. */
export interface SelectResult { status: DiscoveryStatus; contact: BoundContact | null; generic: string | null; failure: ContactFailure | null; /** A bound address seen on a non-authoritative page: a pointer to the entity's own domain to fetch next, never a verification. */ pointer: { email: string; domain: string } | null }


/** Own-domain candidates from a pointer email: only a domain carrying one
 * of the entity's distinctive tokens (never free-mail, never a brokerage
 * domain guessed from a pattern). */
export function pointerDomains(pointerEmails: string[], person: string, entityName: string): string[] {
  const toks = [...new Set([...personTokens(person), ...personTokens(entityName)])].filter((t) => t.length >= 4);
  const out = new Set<string>();
  for (const e of pointerEmails) {
    const domain = e.split("@")[1]?.toLowerCase();
    if (!domain || FREE_MAIL.test(domain)) continue;
    if (toks.some((t) => domain.includes(t))) out.add(domain);
  }
  return [...out];
}

export function selectContact(input: { candidate: DiscoveryCandidate; person: string; role: BoundContact["role"]; sourceUrl: string; sourceType: SourceType; html: string; now: Date }): SelectResult {
  const emails = extractEmails(input.html);
  if (emails.length === 0) return { status: "NOT_FOUND", contact: null, generic: null, failure: "OFFICIAL_PAGE_NO_EMAIL", pointer: null };
  if (REVIEW_ONLY_HOSTS.test(input.sourceUrl)) {
    const bound = emails.find((e) => !isGenericEmail(e.email) && bindsToPerson(e.email, input.person, input.html));
    return { status: "DISCOVERED_UNVERIFIED", contact: null, generic: null, failure: "NO_AUTHORITATIVE_SOURCE", pointer: bound ? { email: bound.email, domain: bound.email.split("@")[1]! } : null };
  }
  const direct = emails.find((e) => !isGenericEmail(e.email) && bindsToPerson(e.email, input.person, input.html));
  if (direct) {
    return { status: "FOUND", generic: null, failure: null, pointer: null, contact: { candidateId: input.candidate.candidateId, person: input.person, role: input.role, email: direct.email, sourceUrl: input.sourceUrl, sourceType: input.sourceType, method: direct.method, literalOnSource: true, identityMatch: true, discoveredAt: input.now.toISOString() } };
  }
  const generic = emails.find((e) => isGenericEmail(e.email) || /^(team|theteam|group|homes|realty|sold|listings)\b/.test(e.email.split("@")[0]!));
  if (generic) return { status: "GENERIC_ONLY", contact: null, generic: generic.email, failure: "GENERIC_ONLY", pointer: null };
  return { status: "REVIEW", contact: null, generic: null, failure: "IDENTITY_AMBIGUOUS", pointer: null };
}

// ------------------------------------------------------------- cache/retry

export interface ResearchAttempt { at: string; sourceType: SourceType; url: string; outcome: "found" | "generic" | ContactFailure }
export interface ResearchRecord {
  candidateId: string;
  version: string;
  lastAttemptedAt: string | null;
  attempts: ResearchAttempt[];
  status: DiscoveryStatus | "PENDING";
  contact: BoundContact | null;
  generic: string | null;
  blockedHosts: string[];
  /** Bound addresses seen on non-authoritative pages (review pointers). */
  pointerEmails?: string[];
}

export const RETRY_AFTER_DAYS: Record<"TEMPORARY_FETCH_ERROR" | "HOST_BLOCKED" | "OFFICIAL_PAGE_NO_EMAIL" | "PROFILE_NOT_FOUND" | "JS_RENDER_REQUIRED", number> = {
  TEMPORARY_FETCH_ERROR: 1,
  HOST_BLOCKED: 14,
  OFFICIAL_PAGE_NO_EMAIL: 30,
  PROFILE_NOT_FOUND: 30,
  JS_RENDER_REQUIRED: 0,
};

/** Should this exact (url) path be attempted now? Never re-fetch a route
 * that recently failed with a non-transient reason; always allow a route
 * never tried. */
export function shouldAttempt(record: ResearchRecord | null, url: string, now: Date): boolean {
  if (!record) return true;
  const prior = [...record.attempts].reverse().find((a) => a.url === url);
  if (!prior) return true;
  if (prior.outcome === "found" || prior.outcome === "generic") return false;
  const days = (RETRY_AFTER_DAYS as Record<string, number>)[prior.outcome] ?? 30;
  return now.getTime() - new Date(prior.at).getTime() > days * 86_400_000;
}

/** Final status once every applicable tier has been tried. */
export function finalizeStatus(attempts: ResearchAttempt[], tiersAvailable: SourceType[]): DiscoveryStatus {
  if (attempts.some((a) => a.outcome === "found")) return "FOUND";
  if (attempts.some((a) => a.outcome === "generic")) return "GENERIC_ONLY";
  const tried = new Set(attempts.map((a) => a.sourceType));
  const untried = tiersAvailable.filter((t) => !tried.has(t));
  if (untried.length > 0) return "DISCOVERED_UNVERIFIED";
  if (attempts.some((a) => a.outcome === "IDENTITY_AMBIGUOUS")) return "REVIEW";
  return "NOT_FOUND";
}

// ------------------------------------------------------------- priority

export interface PriorityInput {
  marketOutboundAllowed: boolean;
  benchmarkStatus: "NONE" | "FRESH" | "STALE";
  marketVerifiedContacts: number;
  waveMinContactVerified: number;
  productionUsd: number | null;
  entityType: "team" | "individual";
  hasDecisionMakerName: boolean;
  hookReady: boolean;
  brokerageAlreadyVerifiedInMarket: number;
}

/** Transparent ordering, highest first. Marginal wave value dominates: a
 * contact that pushes a market over the JIT minimum is worth more than a
 * larger producer in a market with nothing else ready. */
export function researchPriority(i: PriorityInput): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  if (!i.marketOutboundAllowed) return { score: -1, reasons: ["market not outbound-approved: research only"] };
  let score = 0;
  if (i.hookReady) { score += 50; reasons.push("hook-ready: would qualify on the current benchmark if contactable"); }
  const short = Math.max(0, i.waveMinContactVerified - i.marketVerifiedContacts);
  if (short > 0 && short <= 4) { score += 30; reasons.push(`${short} contacts short of the wave minimum`); }
  else if (short > 4) { score += 10; reasons.push(`${short} contacts short of the wave minimum`); }
  if (i.benchmarkStatus === "FRESH") { score += 15; reasons.push("fresh benchmark reusable"); }
  const prod = i.productionUsd ?? 0;
  score += Math.min(20, Math.round(prod / 5_000_000)); reasons.push(`production $${Math.round(prod / 1e6)}M`);
  if (i.entityType === "team" && i.hasDecisionMakerName) { score += 8; reasons.push("named team lead"); }
  if (i.entityType === "individual") { score += 4; reasons.push("individual: person is the decision maker"); }
  if (i.brokerageAlreadyVerifiedInMarket >= 3) { score -= 10; reasons.push("brokerage bucket already has 3+ verified in this market"); }
  return { score, reasons };
}

// --------------------------------------------------------- funnel metrics

export interface DiscoveryFunnel {
  prequalified: number;
  queued: number;
  attempted: number;
  emailDiscovered: number;
  literalVerified: number;
  genericOnly: number;
  blocked: number;
  notFound: number;
  reviewRequired: number;
  promoted: number;
}

export function pathPerformance(records: ResearchRecord[]): Record<SourceType, { attempts: number; verified: number; generic: number; blocked: number }> {
  const out = {} as Record<SourceType, { attempts: number; verified: number; generic: number; blocked: number }>;
  for (const r of records) for (const a of r.attempts) {
    const row = (out[a.sourceType] ??= { attempts: 0, verified: 0, generic: 0, blocked: 0 });
    row.attempts += 1;
    if (a.outcome === "found") row.verified += 1;
    else if (a.outcome === "generic") row.generic += 1;
    else if (a.outcome === "HOST_BLOCKED" || a.outcome === "JS_RENDER_REQUIRED") row.blocked += 1;
  }
  return out;
}
