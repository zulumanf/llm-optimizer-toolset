/**
 * Contact discovery runner (2026-09-14): deterministic, cached, bounded.
 * Ranks the supply engine's prequalified contact queue by marginal wave
 * value, then for each candidate walks the cascade in
 * lib/prospects/contact-discovery.ts:
 *   T0 existing data (website on file) → T1 own-domain pages → T2/T3
 *   search-discovered official pages (Brave public results, aggregator
 *   hosts removed) → T4 headless render when a page is a JS shell.
 * Emails are extracted by code (mailto / JSON-LD / literal / Cloudflare),
 * bound to the decision maker deterministically, and every FOUND row is
 * re-verified by the canonical verifier at promotion. No model is called.
 *
 * Cache: .local-data/supply/contact-research-cache.json (per candidate:
 * attempts, outcomes, blocked hosts) — a failed route is not retried
 * before its RETRY_AFTER_DAYS. Output: promote-ready JSON + funnel.
 *
 * Run: DATABASE_URL=<direct url> npx tsx scripts/contact-discover.ts [--limit 60] [--market "reno|NV"] [--concurrency 4] [--no-render]
 */
import "dotenv/config";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { sql } from "@/db/client";
import {
  CONTACT_DISCOVERY_VERSION,
  classifyFetch,
  extractResultLinks,
  finalizeStatus,
  ownDomainUrls,
  pathPerformance,
  pointerDomains,
  rankResultLinks,
  researchPriority,
  searchQueries,
  selectContact,
  shouldAttempt,
  type BoundContact,
  type ContactFailure,
  type DiscoveryCandidate,
  type FetchOutcome,
  type ResearchAttempt,
  type ResearchRecord,
  type SourceType,
} from "@/lib/prospects/contact-discovery";
import { closeRenderer, renderPageHtml, withRenderer } from "@/lib/prospects/contact-render";
import { waveSizing } from "@/lib/prospects/supply-engine";

const exec = promisify(execFile);
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const CACHE = ".local-data/supply/contact-research-cache.json";
const SEARCH_INTERVAL_MS = 6000;
const MAX_LINKS_PER_QUERY = 4;
const MAX_QUERIES = 2;

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? dflt) : dflt;
}

const counters = { fetches: 0, searches: 0, renders: 0, extractions: 0, llmReviews: 0 };

async function fetchHtml(url: string): Promise<FetchOutcome> {
  counters.fetches += 1;
  try {
    const { stdout } = await exec("curl", ["-sL", "--max-time", "20", "-A", UA, "-w", "\n__STATUS__%{http_code}", url], { maxBuffer: 8 * 1024 * 1024 });
    const idx = stdout.lastIndexOf("\n__STATUS__");
    const status = Number(stdout.slice(idx + 11).trim() || 0);
    const html = stdout.slice(0, idx);
    if (status >= 400 || status === 0) return { kind: "http_error", status };
    return { kind: "ok", status, html };
  } catch (e) {
    return { kind: "network_error", message: (e as Error).message };
  }
}

/** Public search engines, tried in order; each is rate-limit aware. A
 * 429 / CAPTCHA page marks the engine blocked for ENGINE_BACKOFF_MINUTES
 * (persisted in the cache file) — never bypassed, never hammered. When
 * every engine is blocked the batch stops cleanly and the candidates it
 * did not finish stay PENDING. */
const ENGINE_BACKOFF_MINUTES = 20;
type Engine = { name: string; url: (q: string) => string; parse: (html: string) => string[]; ua: string };
const ENGINES: Engine[] = [
  { name: "brave", url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`, parse: extractResultLinks, ua: UA },
];
const engineBlockedUntil: Record<string, number> = {};
let lastSearchAt = 0;
let searchExhausted = false;

function engineBlocked(html: string, status: number): boolean {
  return status === 429 || status === 403 || /captcha|unusual traffic|are you a robot|verify you are human/i.test(html.slice(0, 20_000));
}

async function search(query: string): Promise<{ links: string[]; exhausted: boolean }> {
  const now = Date.now();
  for (const engine of ENGINES) {
    if ((engineBlockedUntil[engine.name] ?? 0) > now) continue;
    const wait = lastSearchAt + SEARCH_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSearchAt = Date.now();
    counters.searches += 1;
    let out: FetchOutcome;
    try {
      const { stdout } = await exec("curl", ["-sL", "--max-time", "20", "-A", engine.ua, "-w", "\n__STATUS__%{http_code}", engine.url(query)], { maxBuffer: 8 * 1024 * 1024 });
      const idx = stdout.lastIndexOf("\n__STATUS__");
      const status = Number(stdout.slice(idx + 11).trim() || 0);
      out = status >= 400 ? { kind: "http_error", status } : { kind: "ok", status, html: stdout.slice(0, idx) };
    } catch (e) { out = { kind: "network_error", message: (e as Error).message }; }
    const html = out.kind === "ok" ? out.html : "";
    const status = out.kind === "network_error" ? 0 : out.status;
    if (engineBlocked(html, status)) {
      engineBlockedUntil[engine.name] = Date.now() + ENGINE_BACKOFF_MINUTES * 60_000;
      console.error(`search engine ${engine.name} rate-limited (HTTP ${status}); backing off ${ENGINE_BACKOFF_MINUTES} min`);
      continue;
    }
    if (out.kind !== "ok") continue;
    return { links: engine.parse(html), exhausted: false };
  }
  searchExhausted = true;
  return { links: [], exhausted: true };
}

interface QueueEntry { market: string; entity: string; entityType: "team" | "individual"; teamLead: string | null; brokerage: string | null; volumeUsd: number | null; sourceRecordId: string; prospectId: string | null; contactability: string }

function loadQueue(): { entries: QueueEntry[]; markets: Record<string, { band: string; contactVerified: number; benchmark: string; policy: string }>; hookReady: Set<string> } {
  const dirs = readdirSync(".local-data/supply").filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  const dir = `.local-data/supply/${dirs[dirs.length - 1]}`;
  const entries = JSON.parse(readFileSync(`${dir}/contact-research-queue.json`, "utf8")) as QueueEntry[];
  const view = JSON.parse(readFileSync(`${dir}/market-supply-view.json`, "utf8")) as { marketsRanked: { market: string; band: string; contactVerified: number; benchmark: string; policy: string }[] };
  const markets: Record<string, { band: string; contactVerified: number; benchmark: string; policy: string }> = {};
  for (const m of view.marketsRanked) {
    const [city, state] = m.market.split(", ");
    markets[`${city!.toLowerCase()}|${state}`] = m;
  }
  const hookReady = new Set<string>();
  const hr = ".local-data/supply/contacts/hookready-targets.json";
  if (existsSync(hr)) for (const h of JSON.parse(readFileSync(hr, "utf8")) as { entity: string }[]) hookReady.add(h.entity.toLowerCase());
  return { entries, markets, hookReady };
}

function loadCache(): Record<string, ResearchRecord> {
  return existsSync(CACHE) ? (JSON.parse(readFileSync(CACHE, "utf8")) as Record<string, ResearchRecord>) : {};
}

async function tryPage(c: DiscoveryCandidate, person: string, role: BoundContact["role"], url: string, sourceType: SourceType, rec: ResearchRecord, now: Date, allowRender: boolean): Promise<"found" | "generic" | ContactFailure> {
  const host = new URL(url).host;
  if (rec.blockedHosts.includes(host) && !allowRender) return "HOST_BLOCKED";
  const out = await fetchHtml(url);
  let failure = classifyFetch(out);
  let html = out.kind === "ok" ? out.html : "";
  let type: SourceType = sourceType;
  // A 403 to a plain fetch is often a bot-fight rule that a real browser
  // passes as ordinary public access; a true challenge/CAPTCHA page comes
  // back as HOST_BLOCKED from the render and is never bypassed.
  const renderable = failure === "JS_RENDER_REQUIRED" || (failure === "HOST_BLOCKED" && out.kind === "http_error" && out.status === 403);
  if (renderable && allowRender) {
    counters.renders += 1;
    try {
      const r = await renderPageHtml(url);
      html = r.html; type = "rendered_page";
      failure = r.status >= 400 ? classifyFetch({ kind: "http_error", status: r.status }) : classifyFetch({ kind: "ok", status: r.status, html });
      if (failure === "JS_RENDER_REQUIRED") failure = "HOST_BLOCKED";
      if (!failure && rec.blockedHosts.includes(host)) rec.blockedHosts = rec.blockedHosts.filter((h) => h !== host);
    } catch { failure = "TEMPORARY_FETCH_ERROR"; }
  }
  const attempt = (outcome: ResearchAttempt["outcome"]): ResearchAttempt => ({ at: now.toISOString(), sourceType: type, url, outcome });
  if (failure) {
    if (failure === "HOST_BLOCKED" && !rec.blockedHosts.includes(host)) rec.blockedHosts.push(host);
    rec.attempts.push(attempt(failure));
    return failure;
  }
  counters.extractions += 1;
  const sel = selectContact({ candidate: c, person, role, sourceUrl: url, sourceType: type, html, now });
  if (sel.status === "FOUND" && sel.contact) { rec.contact = sel.contact; rec.attempts.push(attempt("found")); return "found"; }
  if (sel.status === "GENERIC_ONLY") { rec.generic = rec.generic ?? sel.generic; rec.attempts.push(attempt("generic")); return "generic"; }
  if (sel.pointer) { rec.pointerEmails = [...new Set([...(rec.pointerEmails ?? []), sel.pointer.email])]; }
  rec.attempts.push(attempt(sel.failure ?? "OFFICIAL_PAGE_NO_EMAIL"));
  return sel.failure ?? "OFFICIAL_PAGE_NO_EMAIL";
}

let suppliedUrls: Record<string, string[]> = {};
let skipSearch = false;

async function research(c: DiscoveryCandidate, rec: ResearchRecord, now: Date, allowRender: boolean): Promise<ResearchRecord> {
  const person = c.decisionMaker ?? c.entityName;
  const role: BoundContact["role"] = c.entityType === "individual" ? "agent" : c.decisionMaker ? "team lead" : "unknown";
  rec.lastAttemptedAt = now.toISOString();
  const tiers: SourceType[] = ["search_discovered_page"];
  // Externally supplied page URLs (an approved search step that returns
  // ONLY pointers): fetched, extracted and bound by the same code path.
  for (const url of rankResultLinks(extractResultLinks((suppliedUrls[c.candidateId] ?? []).map((u) => `<a href="${u}">`).join("")), c).slice(0, 6)) {
    if (!shouldAttempt(rec, url, now)) continue;
    const r = await tryPage(c, person, role, url, "search_discovered_page", rec, now, allowRender);
    if (r === "found") { rec.status = "FOUND"; return rec; }
  }
  if (c.website) {
    tiers.unshift("own_domain");
    for (const url of ownDomainUrls(c.website)) {
      if (!shouldAttempt(rec, url, now)) continue;
      const r = await tryPage(c, person, role, url, "own_domain", rec, now, allowRender);
      if (r === "found") { rec.status = "FOUND"; return rec; }
    }
  }
  const seen = new Set<string>();
  for (const q of skipSearch ? [] : searchQueries(c).slice(0, MAX_QUERIES)) {
    const res = await search(q);
    if (res.exhausted) { rec.status = "PENDING"; return rec; } // every engine blocked: leave untouched, stop cleanly
    const links = rankResultLinks(res.links, c).slice(0, MAX_LINKS_PER_QUERY);
    for (const url of links) {
      if (seen.has(url) || !shouldAttempt(rec, url, now)) continue;
      seen.add(url);
      const r = await tryPage(c, person, role, url, "search_discovered_page", rec, now, allowRender);
      if (r === "found") { rec.status = "FOUND"; return rec; }
    }
  }
  // Pointer follow-up: an address seen on a non-authoritative page whose
  // domain carries the entity's own name → fetch that domain's contact
  // pages directly (own-domain tier, no search spend) and verify there.
  for (const domain of pointerDomains(rec.pointerEmails ?? [], person, c.entityName)) {
    for (const url of ownDomainUrls(`https://${domain}`).slice(0, 4)) {
      if (!shouldAttempt(rec, url, now)) continue;
      const r = await tryPage(c, person, role, url, "own_domain", rec, now, allowRender);
      if (r === "found") { rec.status = "FOUND"; return rec; }
      if (r === "HOST_BLOCKED" || r === "PROFILE_NOT_FOUND") break;
    }
  }
  rec.status = finalizeStatus(rec.attempts, tiers);
  return rec;
}

/** Re-fetch every cached FOUND row and re-apply the current binding rules;
 * a row that no longer binds is demoted to REVIEW (its URL is kept). */
async function revalidate(cache: Record<string, ResearchRecord>, entries: QueueEntry[], now: Date): Promise<void> {
  for (const rec of Object.values(cache)) {
    if (rec.status !== "FOUND" || !rec.contact) continue;
    const e = entries.find((x) => x.sourceRecordId === rec.candidateId);
    if (!e) continue;
    const [city, state] = e.market.split("|");
    const c: DiscoveryCandidate = { candidateId: e.sourceRecordId, entityName: e.entity, entityType: e.entityType, decisionMaker: e.teamLead && e.teamLead.trim().split(/\s+/).length >= 2 ? e.teamLead : (e.entityType === "individual" ? e.entity : null), brokerage: e.brokerage, city: city!, state: state!, website: null };
    let html = "";
    if (rec.contact.sourceType === "rendered_page") { try { counters.renders += 1; html = (await renderPageHtml(rec.contact.sourceUrl)).html; } catch { html = ""; } }
    else { const out = await fetchHtml(rec.contact.sourceUrl); html = out.kind === "ok" ? out.html : ""; }
    const sel = html ? selectContact({ candidate: c, person: rec.contact.person, role: rec.contact.role, sourceUrl: rec.contact.sourceUrl, sourceType: rec.contact.sourceType, html, now }) : null;
    if (!sel || sel.status !== "FOUND" || sel.contact?.email !== rec.contact.email) {
      console.log(`DEMOTED ${e.entity}: ${rec.contact.email} @ ${rec.contact.sourceUrl} → ${sel?.status ?? "refetch failed"}`);
      rec.attempts.push({ at: now.toISOString(), sourceType: rec.contact.sourceType, url: rec.contact.sourceUrl, outcome: sel?.failure ?? "TEMPORARY_FETCH_ERROR" });
      rec.contact = null; rec.status = sel?.status === "GENERIC_ONLY" ? "GENERIC_ONLY" : "REVIEW";
    }
  }
  writeFileSync(CACHE, JSON.stringify(cache, null, 1));
}

async function main(): Promise<void> {
  const limit = Number(arg("--limit", "60"));
  const marketFilter = arg("--market", "");
  const concurrency = Number(arg("--concurrency", "4"));
  const allowRender = !process.argv.includes("--no-render");
  const now = new Date();
  const { entries, markets, hookReady } = loadQueue();
  const cache = loadCache();
  const urlsFile = arg("--urls-file", "");
  if (urlsFile) suppliedUrls = JSON.parse(readFileSync(urlsFile, "utf8")) as Record<string, string[]>;
  skipSearch = process.argv.includes("--no-search");
  if (process.argv.includes("--revalidate")) { await revalidate(cache, entries, now); }
  const sizing = waveSizing();
  const verifiedByBrokerage = new Map<string, number>();
  const prioritized = entries
    .filter((e) => !marketFilter || e.market === marketFilter)
    .filter((e) => !urlsFile || Boolean(suppliedUrls[e.sourceRecordId]))
    .filter((e) => (cache[e.sourceRecordId]?.status ?? "PENDING") === "PENDING" || cache[e.sourceRecordId]?.status === "DISCOVERED_UNVERIFIED")
    .map((e) => {
      const m = markets[e.market];
      const p = researchPriority({
        marketOutboundAllowed: Boolean(m) && m!.policy === "PROOF_BUILDING", benchmarkStatus: (m?.benchmark as "NONE" | "FRESH" | "STALE") ?? "NONE",
        marketVerifiedContacts: m?.contactVerified ?? 0, waveMinContactVerified: sizing.minContactVerified, productionUsd: e.volumeUsd,
        entityType: e.entityType, hasDecisionMakerName: Boolean(e.teamLead), hookReady: hookReady.has(e.entity.toLowerCase()),
        brokerageAlreadyVerifiedInMarket: verifiedByBrokerage.get(`${e.market}|${(e.brokerage ?? "").toLowerCase()}`) ?? 0,
      });
      return { e, ...p };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (process.argv.includes("--report")) {
    const recs = Object.values(cache);
    const byMarket: Record<string, Record<string, number>> = {};
    const failures: Record<string, number> = {};
    const blockedHosts: Record<string, number> = {};
    for (const r of recs) {
      const e = entries.find((x) => x.sourceRecordId === r.candidateId);
      const m = e?.market ?? "?";
      (byMarket[m] ??= {})[r.status] = ((byMarket[m] ??= {})[r.status] ?? 0) + 1;
      for (const a of r.attempts) if (a.outcome !== "found" && a.outcome !== "generic") failures[a.outcome] = (failures[a.outcome] ?? 0) + 1;
      for (const h of r.blockedHosts) blockedHosts[h] = (blockedHosts[h] ?? 0) + 1;
    }
    const attempted = recs.filter((r) => r.attempts.length > 0);
    const counts = (st: string) => attempted.filter((r) => r.status === st).length;
    console.log(JSON.stringify({ queue: entries.length, researched: attempted.length, found: counts("FOUND"), genericOnly: counts("GENERIC_ONLY"), discoveredUnverified: counts("DISCOVERED_UNVERIFIED"), review: counts("REVIEW"), notFound: counts("NOT_FOUND"), hitRate: attempted.length ? Math.round((counts("FOUND") / attempted.length) * 1000) / 10 : null, failures, pathPerformance: pathPerformance(attempted), topBlockedHosts: Object.entries(blockedHosts).sort((a, b) => b[1] - a[1]).slice(0, 12), byMarket }, null, 1));
    await sql.end();
    return;
  }
  if (process.argv.includes("--plan")) {
    console.log(JSON.stringify(prioritized.map(({ e, score, reasons }) => ({ id: e.sourceRecordId, entity: e.entity, type: e.entityType, lead: e.teamLead, brokerage: e.brokerage, market: e.market, volumeUsd: e.volumeUsd, score, reasons })), null, 1));
    await sql.end();
    return;
  }
  const websites = new Map<string, string>();
  const pids = prioritized.map((x) => x.e.prospectId).filter((x): x is string => Boolean(x));
  if (pids.length) for (const r of await sql`select id, website from prospects where id = any(${pids}::uuid[]) and website is not null`) websites.set(r.id as string, r.website as string);

  let idx = 0;
  const results: ResearchRecord[] = [];
  const worker = async () => {
    while (idx < prioritized.length) {
      if (searchExhausted) { console.error("SEARCH_RATE_LIMITED: all engines backing off — stopping batch cleanly"); return; }
      const { e } = prioritized[idx++]!;
      const [city, state] = e.market.split("|");
      const c: DiscoveryCandidate = { candidateId: e.sourceRecordId, entityName: e.entity, entityType: e.entityType, decisionMaker: e.teamLead && e.teamLead.trim().split(/\s+/).length >= 2 ? e.teamLead : (e.entityType === "individual" ? e.entity : null), brokerage: e.brokerage, city: city!, state: state!, website: e.prospectId ? (websites.get(e.prospectId) ?? null) : null };
      const rec: ResearchRecord = cache[e.sourceRecordId] ?? { candidateId: e.sourceRecordId, version: CONTACT_DISCOVERY_VERSION, lastAttemptedAt: null, attempts: [], status: "PENDING", contact: null, generic: null, blockedHosts: [] };
      try { await research(c, rec, now, allowRender); } catch (err) { rec.attempts.push({ at: now.toISOString(), sourceType: "search_discovered_page", url: "n/a", outcome: "TEMPORARY_FETCH_ERROR" }); rec.status = finalizeStatus(rec.attempts, ["search_discovered_page"]); console.error(`error ${e.entity}: ${(err as Error).message}`); }
      if (rec.status === "PENDING") { cache[e.sourceRecordId] = rec; continue; } // untouched by a blocked engine
      cache[e.sourceRecordId] = rec;
      results.push(rec);
      const tag = rec.status === "FOUND" ? `FOUND ${rec.contact!.email} (${rec.contact!.sourceType}/${rec.contact!.method})` : `${rec.status}${rec.generic ? ` generic=${rec.generic}` : ""}`;
      console.log(`${e.market.padEnd(20)} ${e.entity.padEnd(42)} ${tag}`);
      writeFileSync(CACHE, JSON.stringify(cache, null, 1));
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, prioritized.length) }, worker));
  await closeRenderer();

  const promote = results.filter((r) => r.status === "FOUND" && r.contact).map((r) => {
    const e = entries.find((x) => x.sourceRecordId === r.candidateId)!;
    return { ...(e.prospectId ? { prospectId: e.prospectId } : { sourceRecordId: e.sourceRecordId }), person: r.contact!.person, role: r.contact!.role, email: r.contact!.email, sourceUrl: r.contact!.sourceUrl, sourceType: r.contact!.sourceType, notes: `contact-discover ${now.toISOString().slice(0, 10)}: ${r.contact!.sourceType}/${r.contact!.method}; entity ${e.entity}` };
  });
  mkdirSync(".local-data/supply/contacts", { recursive: true });
  const out = `.local-data/supply/contacts/discovered-${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
  writeFileSync(out, JSON.stringify(promote, null, 1));
  const status = (s: string) => results.filter((r) => r.status === s).length;
  const failures: Record<string, number> = {};
  for (const r of results) for (const a of r.attempts) if (a.outcome !== "found" && a.outcome !== "generic") failures[a.outcome] = (failures[a.outcome] ?? 0) + 1;
  console.log(JSON.stringify({ attempted: results.length, found: status("FOUND"), genericOnly: status("GENERIC_ONLY"), discoveredUnverified: status("DISCOVERED_UNVERIFIED"), review: status("REVIEW"), notFound: status("NOT_FOUND"), failures, pathPerformance: pathPerformance(results), counters, promoteFile: out }, null, 1));
  await sql.end();
}

// withRenderer: the headless browser closes on every exit path (hardening 2026-09-14).
withRenderer(main).catch((e) => { console.error(e); process.exit(1); });
