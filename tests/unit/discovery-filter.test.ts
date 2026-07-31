import { describe, it, expect } from "vitest";
import {
  buildDiscoveryQueries,
  discoveryPrompt,
  MAX_QUERIES_PER_RUN,
} from "@/lib/knowledge/discovery/queries";
import {
  screenCandidate,
  screenAll,
  domainsMatch,
  requiresAttribution,
  attributionPrefix,
  SKIP_REASON_LABEL,
  type ScreenContext,
} from "@/lib/knowledge/discovery/filter";
import { parseRobots, isPathAllowed } from "@/lib/knowledge/discovery/robots";

const IDENTITY = {
  name: "Harbour Line Group",
  aliases: ["Harbour Line", "Harbour Line Group"],
  domain: "harbourline.example",
  principals: ["Dana Okafor", "Sam Reyes", "Third Person"],
  markets: ["Jersey City", "Hoboken", "Montclair", "Fourth Market"],
  affiliation: "Example Brokerage",
};

function ctx(over: Partial<ScreenContext> = {}): ScreenContext {
  return {
    ownDomain: "harbourline.example",
    alreadyIngested: new Set<string>(),
    seenInRun: new Set<string>(),
    maxPages: 10,
    keptSoFar: 0,
    ...over,
  };
}

describe("discovery query construction", () => {
  it("is deterministic: same identity in, same queries out", () => {
    const a = buildDiscoveryQueries(IDENTITY);
    const b = buildDiscoveryQueries(IDENTITY);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("caps breadth, keeping the highest-priority templates", () => {
    const wide = buildDiscoveryQueries({
      ...IDENTITY,
      aliases: Array.from({ length: 20 }, (_, i) => `Alias ${i}`),
      markets: Array.from({ length: 20 }, (_, i) => `Market ${i}`),
    });
    expect(wide.length).toBeLessThanOrEqual(MAX_QUERIES_PER_RUN);
    // The bare-name query is first priority and must survive truncation.
    expect(wide[0]!.template).toBe("name");
  });

  it("bounds principals and markets rather than searching every one", () => {
    const queries = buildDiscoveryQueries(IDENTITY);
    expect(queries.filter((q) => q.template === "principal").length).toBeLessThanOrEqual(2);
    expect(queries.filter((q) => q.template === "name_market").length).toBeLessThanOrEqual(3);
  });

  it("does not pay twice for an alias identical to the name", () => {
    const queries = buildDiscoveryQueries(IDENTITY);
    const texts = queries.map((q) => q.text.toLowerCase());
    expect(new Set(texts).size).toBe(texts.length);
  });

  it("omits templates whose inputs are absent", () => {
    const bare = buildDiscoveryQueries({ name: "Solo Co" });
    expect(bare.some((q) => q.template === "principal")).toBe(false);
    expect(bare.some((q) => q.template === "name_affiliation")).toBe(false);
    expect(bare.some((q) => q.template === "name")).toBe(true);
  });

  it("asks for consulted sources, not a remembered answer", () => {
    const prompt = discoveryPrompt('"Harbour Line Group"', "harbourline.example");
    expect(prompt).toMatch(/pages you consulted/i);
    expect(prompt).toMatch(/Do not summarise from memory/i);
    expect(prompt).toContain("harbourline.example");
  });
});

describe("candidate screening", () => {
  it("drops the client's own site, including subdomains", () => {
    for (const url of [
      "https://harbourline.example/team",
      "https://www.harbourline.example/about",
      "https://blog.harbourline.example/post",
    ]) {
      const r = screenCandidate({ url, title: null, sourceQuery: "q" }, ctx());
      expect(r.keep).toBe(false);
      if (!r.keep) expect(r.reason).toBe("own_domain");
    }
  });

  it("keeps third-party pages", () => {
    const r = screenCandidate(
      { url: "https://press.example/article", title: "Piece", sourceQuery: "q" },
      ctx()
    );
    expect(r.keep).toBe(true);
  });

  it("blocks private hosts — the SSRF guard is shared with ingestSource", () => {
    for (const url of [
      "http://localhost/admin",
      "http://127.0.0.1/x",
      "http://10.0.0.5/x",
      "http://192.168.1.9/x",
    ]) {
      const r = screenCandidate({ url, title: null, sourceQuery: "q" }, ctx());
      expect(r.keep).toBe(false);
      if (!r.keep) expect(r.reason).toBe("private_host");
    }
  });

  it("rejects non-http schemes", () => {
    const r = screenCandidate(
      { url: "ftp://files.example/doc.pdf", title: null, sourceQuery: "q" },
      ctx()
    );
    expect(r.keep).toBe(false);
    if (!r.keep) expect(r.reason).toBe("unsupported_scheme");
  });

  it("treats a page already held as already held, not as new", () => {
    const r = screenCandidate(
      { url: "https://press.example/article", title: null, sourceQuery: "q" },
      ctx({ alreadyIngested: new Set(["https://press.example/article"]) })
    );
    expect(r.keep).toBe(false);
    if (!r.keep) expect(r.reason).toBe("already_ingested");
  });

  it("dedupes within a run across different queries", () => {
    const results = screenAll(
      [
        { url: "https://press.example/a", title: null, sourceQuery: "q1" },
        { url: "https://press.example/a?utm_source=x", title: null, sourceQuery: "q2" },
      ],
      ctx()
    );
    expect(results[0]!.keep).toBe(true);
    expect(results[1]!.keep).toBe(false);
    if (!results[1]!.keep) expect(results[1]!.reason).toBe("duplicate_in_run");
  });

  it("reports the first true reason, not an arbitrary cap", () => {
    // Own-domain AND over the cap: the specific reason must win.
    const r = screenCandidate(
      { url: "https://harbourline.example/x", title: null, sourceQuery: "q" },
      ctx({ maxPages: 1, keptSoFar: 5 })
    );
    expect(r.keep).toBe(false);
    if (!r.keep) expect(r.reason).toBe("own_domain");
  });

  it("stops at the page cap with a stated reason", () => {
    const r = screenCandidate(
      { url: "https://press.example/b", title: null, sourceQuery: "q" },
      ctx({ maxPages: 2, keptSoFar: 2 })
    );
    expect(r.keep).toBe(false);
    if (!r.keep) expect(r.reason).toBe("cap_reached");
  });

  it("every skip reason has operator-facing wording", () => {
    for (const reason of Object.keys(SKIP_REASON_LABEL)) {
      expect(SKIP_REASON_LABEL[reason as keyof typeof SKIP_REASON_LABEL].length).toBeGreaterThan(5);
    }
  });
});

describe("attribution", () => {
  it("requires attribution for third-party sources", () => {
    expect(requiresAttribution("jerseydigs.example", "harbourline.example")).toBe(true);
  });

  it("does not attribute the client's own statements", () => {
    expect(requiresAttribution("harbourline.example", "harbourline.example")).toBe(false);
    expect(requiresAttribution("www.harbourline.example", "harbourline.example")).toBe(false);
  });

  it("attributes to the serving domain, never an invented brand name", () => {
    expect(attributionPrefix("www.jerseydigs.example")).toBe("jerseydigs.example reports that");
  });

  it("attributes when the client's own domain is unknown", () => {
    expect(requiresAttribution("anything.example", undefined)).toBe(true);
  });

  it("matches domains symmetrically", () => {
    expect(domainsMatch("a.example", "a.example")).toBe(true);
    expect(domainsMatch("sub.a.example", "a.example")).toBe(true);
    expect(domainsMatch("a.example", "b.example")).toBe(false);
    expect(domainsMatch("", "a.example")).toBe(false);
  });
});

describe("robots.txt", () => {
  it("honours a wildcard disallow", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /private");
    expect(isPathAllowed("/private/x", rules)).toBe(false);
    expect(isPathAllowed("/public/x", rules)).toBe(true);
  });

  it("lets a specific rule for us replace the wildcard group", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: ParvaVisibilityAudit\nDisallow: /secret"
    );
    expect(isPathAllowed("/anything", rules)).toBe(true);
    expect(isPathAllowed("/secret/x", rules)).toBe(false);
  });

  it("treats an empty Disallow as permitting everything", () => {
    const rules = parseRobots("User-agent: *\nDisallow:");
    expect(isPathAllowed("/anything", rules)).toBe(true);
  });

  it("lets a longer Allow re-permit a page inside a disallowed directory", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /news\nAllow: /news/public");
    expect(isPathAllowed("/news/private", rules)).toBe(false);
    expect(isPathAllowed("/news/public/item", rules)).toBe(true);
  });

  it("supports a trailing wildcard", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /tmp*");
    expect(isPathAllowed("/tmpfile", rules)).toBe(false);
  });

  it("ignores comments and unrelated agents", () => {
    const rules = parseRobots("# comment\nUser-agent: SomeBot\nDisallow: /\n");
    expect(isPathAllowed("/anything", rules)).toBe(true);
  });

  it("permits everything when robots.txt is empty or unparseable", () => {
    expect(isPathAllowed("/x", parseRobots(""))).toBe(true);
    expect(isPathAllowed("/x", parseRobots("garbage without colons"))).toBe(true);
  });
});
