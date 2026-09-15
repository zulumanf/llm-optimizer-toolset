/**
 * Contact discovery cascade (2026-09-14): discovery is broad, verification
 * is strict. These pin the extraction, routing, binding, cache and priority
 * rules — and that nothing here can turn a guess or a snippet into a
 * sendable address.
 */
import { describe, expect, it } from "vitest";
import {
  bindsToPerson,
  classifyFetch,
  extractEmails,
  extractResultLinks,
  finalizeStatus,
  looksLikeJsShell,
  normalizeEmail,
  ownDomainUrls,
  pointerDomains,
  rankResultLinks,
  researchPriority,
  searchQueries,
  selectContact,
  shouldAttempt,
  type DiscoveryCandidate,
  type ResearchRecord,
} from "@/lib/prospects/contact-discovery";
import { htmlStatesEmail } from "@/lib/prospects/contact-verify";
import { promotionIdentityCheck } from "@/lib/prospects/supply-engine";

const NOW = new Date("2026-09-14T12:00:00Z");
const cand: DiscoveryCandidate = { candidateId: "r1", entityName: "Hodges & Associates Real Estate Group", entityType: "team", decisionMaker: "Jessica Hodges", brokerage: "The Real Brokerage", city: "Reno", state: "NV", website: null };

describe("email extraction (1–4)", () => {
  it("extracts mailto, visible text, JSON-LD and Cloudflare-encoded addresses", () => {
    const cf = "8f" + Buffer.from("jess@homeisnv.com").toString("utf8").split("").map((ch) => (ch.charCodeAt(0) ^ 0x8f).toString(16).padStart(2, "0")).join("");
    const html = `<a href="mailto:Jessica@HomeIsNV.com?subject=hi">Email</a><p>Reach Jessica at jessica.hodges@example-broker.com</p>
      <script type="application/ld+json">{"@type":"RealEstateAgent","email":"team@homeisnv.com"}</script><a data-cfemail="${cf}">x</a>`;
    const got = extractEmails(html);
    expect(got.map((e) => `${e.email}:${e.method}`)).toEqual(expect.arrayContaining(["jessica@homeisnv.com:mailto", "jessica.hodges@example-broker.com:visible_text", "team@homeisnv.com:json_ld", "jess@homeisnv.com:cloudflare_encoded"]));
  });

  it("rejects malformed and asset-like addresses", () => {
    expect(normalizeEmail("mailto:not-an-email")).toBeNull();
    expect(normalizeEmail("logo@2x.png")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
    expect(extractEmails("<img src='hero@2x.png'> contact: jess@homeisnv.com")).toEqual([{ email: "jess@homeisnv.com", method: "visible_text" }]);
  });
});

describe("fetch classification (9, 11, 18)", () => {
  it("403 becomes HOST_BLOCKED, never a contact verdict", () => {
    expect(classifyFetch({ kind: "http_error", status: 403 })).toBe("HOST_BLOCKED");
    expect(classifyFetch({ kind: "http_error", status: 429 })).toBe("HOST_BLOCKED");
    expect(classifyFetch({ kind: "http_error", status: 404 })).toBe("PROFILE_NOT_FOUND");
    expect(classifyFetch({ kind: "network_error", message: "timeout" })).toBe("TEMPORARY_FETCH_ERROR");
  });

  it("a JS shell escalates to the renderer instead of counting as empty", () => {
    const shell = `<html><head><script src="/bundle.js"></script></head><body><div id="root"></div></body></html>`;
    expect(looksLikeJsShell(shell)).toBe(true);
    expect(classifyFetch({ kind: "ok", status: 200, html: shell })).toBe("JS_RENDER_REQUIRED");
    const real = `<html><body><h1>Jessica Hodges</h1><p>${"Reno real estate team serving Somersett and Caughlin Ranch. ".repeat(6)}</p><a href="mailto:jess@homeisnv.com">Email</a></body></html>`;
    expect(classifyFetch({ kind: "ok", status: 200, html: real })).toBeNull();
  });
});

describe("search discovery (7, 8, 10)", () => {
  it("extracts result links but drops aggregator, social and enrichment-database hosts", () => {
    const html = `<a href="https://kyliekeenan.dicksonrealty.com/">x</a><a href="https://www.zoominfo.com/p/Kylie/1">z</a><a href="https://www.homes.com/real-estate-agents/kylie-keenan/">h</a><a href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.dicksonrealty.com%2Fagent%2Fkylie-keenan">d</a>`;
    expect(extractResultLinks(html)).toEqual(["https://kyliekeenan.dicksonrealty.com/", "https://www.dicksonrealty.com/agent/kylie-keenan"]);
  });

  it("ranks pages carrying the person's and team's tokens first", () => {
    const ranked = rankResultLinks(["https://www.realtrends.com/rankings", "https://homeisnv.com/contact", "https://www.compass.com/agents/jessica-hodges/"], cand);
    expect(ranked[0]).toMatch(/jessica-hodges|homeisnv/);
    expect(ranked).not.toContain("https://www.realtrends.com/rankings");
  });

  it("generates deterministic queries from the candidate's own facts", () => {
    const q = searchQueries(cand);
    expect(q[0]).toContain('"Jessica Hodges"');
    expect(q.some((s) => s.includes("Reno"))).toBe(true);
    expect(ownDomainUrls("https://homeisnv.com/")).toContain("https://homeisnv.com/contact");
  });

  it("a snippet alone never verifies: the literal must be on the fetched page", () => {
    const snippetOnly = "Contact Jessica at jess@homeisnv.com — from search results";
    expect(htmlStatesEmail("<html><body>Jessica Hodges — Reno</body></html>", "jess@homeisnv.com")).toBe(false);
    expect(htmlStatesEmail(`<html><body>${snippetOnly}</body></html>`, "jess@homeisnv.com")).toBe(true);
  });
});

describe("binding and selection (12, 13, 14, 16)", () => {
  const page = (body: string) => `<html><body><h1>Jessica Hodges</h1>${body}</body></html>`;
  it("prefers the decision-maker's direct address and keeps generic inboxes separate", () => {
    const r = selectContact({ candidate: cand, person: "Jessica Hodges", role: "team lead", sourceUrl: "https://homeisnv.com/contact", sourceType: "own_domain", html: page(`<a href="mailto:info@homeisnv.com">office</a> <a href="mailto:jessica@homeisnv.com">me</a>`), now: NOW });
    expect(r.status).toBe("FOUND");
    expect(r.contact).toMatchObject({ email: "jessica@homeisnv.com", role: "team lead", sourceType: "own_domain", literalOnSource: true, identityMatch: true });
    const g = selectContact({ candidate: cand, person: "Jessica Hodges", role: "team lead", sourceUrl: "u", sourceType: "own_domain", html: page(`<a href="mailto:info@homeisnv.com">office</a>`), now: NOW });
    expect(g.status).toBe("GENERIC_ONLY");
    expect(g.contact).toBeNull();
  });

  it("another agent's address on the page is never bound to the candidate", () => {
    const r = selectContact({ candidate: cand, person: "Jessica Hodges", role: "team lead", sourceUrl: "u", sourceType: "search_discovered_page", html: `<html><body><h1>Our agents</h1><a href="mailto:tom.reilly@homeisnv.com">Tom</a></body></html>`, now: NOW });
    expect(r.status).toBe("REVIEW");
    expect(r.failure).toBe("IDENTITY_AMBIGUOUS");
  });

  it("a guessed pattern cannot enter: binding only reads addresses extracted from the page", () => {
    expect(bindsToPerson("jessica.hodges@therealbrokerage.com", "Jessica Hodges", "<p>no such address here</p>")).toBe(true);
    // ...but selectContact never sees it because extraction found nothing on the page
    const r = selectContact({ candidate: cand, person: "Jessica Hodges", role: "team lead", sourceUrl: "u", sourceType: "own_domain", html: "<html><body>Jessica Hodges, Reno</body></html>", now: NOW });
    expect(r.status).toBe("NOT_FOUND");
    expect(r.failure).toBe("OFFICIAL_PAGE_NO_EMAIL");
  });

  it("a team lead's email contacts the team without changing the measured entity", () => {
    const r = selectContact({ candidate: cand, person: "Jessica Hodges", role: "team lead", sourceUrl: "u", sourceType: "own_domain", html: page(`<a href="mailto:jessica@homeisnv.com">me</a>`), now: NOW });
    expect(r.contact!.candidateId).toBe("r1");
    expect(cand.entityType).toBe("team");
  });
});

describe("binding hardening (2026-09-14 smoke findings)", () => {
  const team: DiscoveryCandidate = { ...cand, candidateId: "r2", entityName: "Karasawa Wood Real Estate Group", entityType: "team", decisionMaker: null };
  it("a generic word like 'group' never binds another team's address from a roster", () => {
    const r = selectContact({ candidate: team, person: team.entityName, role: "unknown", sourceUrl: "https://broker.example/our-agents/", sourceType: "search_discovered_page", html: `<html><body><h2>Our agents</h2><a href="mailto:nashconnollygroup@gmail.com">Nash Connolly Group</a></body></html>`, now: NOW });
    expect(r.status).toBe("REVIEW");
    expect(bindsToPerson("nashconnollygroup@gmail.com", "Karasawa Wood Real Estate Group", "")).toBe(false);
    expect(bindsToPerson("lindsay@lclarkegroup.com", "L Clarke Group", "")).toBe(true);
    expect(bindsToPerson("hello@karasawawood.com", "Karasawa Wood Real Estate Group", "")).toBe(true);
  });
  it("a roster printing the lead's name next to another agent's mailto never binds (Kris Weaver case)", () => {
    const team: DiscoveryCandidate = { ...cand, candidateId: "r3", entityName: "Kris Weaver Real Estate Team", decisionMaker: "Kris Weaver" };
    const r = selectContact({ candidate: team, person: "Kris Weaver", role: "team lead", sourceUrl: "https://krisweaver.com/contact", sourceType: "rendered_page", html: `<html><body><h1>Kris Weaver Real Estate Team</h1><p>Kris Weaver, founder</p><a href="mailto:john.koulis@atlanticsir.com">John</a></body></html>`, now: NOW });
    expect(r.status).toBe("REVIEW");
    expect(bindsToPerson("kris@krisweaver.com", "Kris Weaver", "")).toBe(true);
    expect(bindsToPerson("kgood@rwtowne.com", "Kathy B Good", "")).toBe(true);
    expect(bindsToPerson("brian@surfhomesnc.com", "Brian Inskip", "<h1>Brian Inskip</h1>")).toBe(true);
    expect(bindsToPerson("brian@surfhomesnc.com", "Brian Inskip", "<h1>Our agents</h1>")).toBe(false);
  });
  it("press wires and agent aggregators are pointers for review, never automatic finds", () => {
    const r = selectContact({ candidate: cand, person: "Jessica Hodges", role: "team lead", sourceUrl: "https://www.newswire.com/news/best-agent-jessica-hodges", sourceType: "search_discovered_page", html: `<html><body>Jessica Hodges jessica@homeisnv.com</body></html>`, now: NOW });
    expect(r.status).toBe("DISCOVERED_UNVERIFIED");
    expect(r.failure).toBe("NO_AUTHORITATIVE_SOURCE");
    expect(r.contact).toBeNull();
    expect(r.pointer).toEqual({ email: "jessica@homeisnv.com", domain: "homeisnv.com" });
  });
  it("a pointer only yields the entity's OWN domain to fetch next — never free mail, never a guessed brokerage domain", () => {
    expect(pointerDomains(["lindsay@lclarkegroup.com"], "Lindsay Clarke", "L Clarke Group")).toEqual(["lclarkegroup.com"]);
    expect(pointerDomains(["lindsay.clarke@gmail.com"], "Lindsay Clarke", "L Clarke Group")).toEqual([]);
    expect(pointerDomains(["rberman@dicksonrealty.com"], "Richard Berman", "The Berman Group")).toEqual([]);
  });
});

describe("identity fail-closed (15)", () => {
  it("TEAM record machine-matched to a person-named company is rejected", () => {
    const v = promotionIdentityCheck({ entityName: "The Lipschutz Group", entityType: "team", matchStatus: "high_confidence" }, { name: "Tristan Lipschutz", measuredLevel: null });
    expect(v.ok).toBe(false);
    expect(!v.ok && v.reason).toBe("ENTITY_TYPE_MISMATCH");
  });
  it("a company measured at another level never absorbs the record, even when confirmed by name", () => {
    const v = promotionIdentityCheck({ entityName: "Smith", entityType: "individual", matchStatus: "confirmed" }, { name: "Smith", measuredLevel: "team" });
    expect(v.ok).toBe(false);
  });
  it("exact-name or human-confirmed same-level matches pass", () => {
    expect(promotionIdentityCheck({ entityName: "Shea Team", entityType: "team", matchStatus: "high_confidence" }, { name: "shea team", measuredLevel: "team" }).ok).toBe(true);
    expect(promotionIdentityCheck({ entityName: "Shea Team", entityType: "team", matchStatus: "confirmed" }, { name: "Shea Real Estate Team", measuredLevel: null }).ok).toBe(true);
    expect(promotionIdentityCheck({ entityName: "Shea Team", entityType: "team", matchStatus: "unmatched" }, null).ok).toBe(true);
  });
});

describe("cache, retry and finalization (17, 19, 20)", () => {
  const rec = (outcome: ResearchRecord["attempts"][number]["outcome"], daysAgo: number): ResearchRecord => ({ candidateId: "r1", version: "v", lastAttemptedAt: null, attempts: [{ at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString(), sourceType: "own_domain", url: "https://x/contact", outcome }], status: "PENDING", contact: null, generic: null, blockedHosts: [] });
  it("does not re-fetch a route that recently failed non-transiently, but retries transient failures", () => {
    expect(shouldAttempt(rec("HOST_BLOCKED", 1), "https://x/contact", NOW)).toBe(false);
    expect(shouldAttempt(rec("HOST_BLOCKED", 20), "https://x/contact", NOW)).toBe(true);
    expect(shouldAttempt(rec("TEMPORARY_FETCH_ERROR", 2), "https://x/contact", NOW)).toBe(true);
    expect(shouldAttempt(rec("OFFICIAL_PAGE_NO_EMAIL", 3), "https://x/contact", NOW)).toBe(false);
    expect(shouldAttempt(rec("HOST_BLOCKED", 1), "https://y/other", NOW)).toBe(true);
    expect(shouldAttempt(null, "https://x/contact", NOW)).toBe(true);
  });
  it("a blocked host is not NO_CONTACT until every tier was tried; alternate sources can still recover it", () => {
    const blocked = rec("HOST_BLOCKED", 0);
    expect(finalizeStatus(blocked.attempts, ["own_domain", "search_discovered_page"])).toBe("DISCOVERED_UNVERIFIED");
    const recovered = [...blocked.attempts, { at: NOW.toISOString(), sourceType: "search_discovered_page" as const, url: "https://own.site/contact", outcome: "found" as const }];
    expect(finalizeStatus(recovered, ["own_domain", "search_discovered_page"])).toBe("FOUND");
    const exhausted = [...blocked.attempts, { at: NOW.toISOString(), sourceType: "search_discovered_page" as const, url: "https://a/b", outcome: "OFFICIAL_PAGE_NO_EMAIL" as const }];
    expect(finalizeStatus(exhausted, ["own_domain", "search_discovered_page"])).toBe("NOT_FOUND");
  });
});

describe("priority (21, 22)", () => {
  const base = { marketOutboundAllowed: true, benchmarkStatus: "FRESH" as const, marketVerifiedContacts: 5, waveMinContactVerified: 7, productionUsd: 40_000_000, entityType: "team" as const, hasDecisionMakerName: true, hookReady: false, brokerageAlreadyVerifiedInMarket: 0 };
  it("marginal wave value and hook-readiness outrank raw production", () => {
    const nearWave = researchPriority(base).score;
    const bigButFar = researchPriority({ ...base, productionUsd: 120_000_000, marketVerifiedContacts: 0 }).score;
    expect(nearWave).toBeGreaterThan(bigButFar);
    expect(researchPriority({ ...base, hookReady: true }).score).toBeGreaterThan(nearWave);
  });
  it("an unclassified market is research-only and never enters the outbound queue", () => {
    const r = researchPriority({ ...base, marketOutboundAllowed: false });
    expect(r.score).toBe(-1);
    expect(r.reasons[0]).toMatch(/not outbound-approved/);
  });
});
