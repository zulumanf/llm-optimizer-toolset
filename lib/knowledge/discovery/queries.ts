/**
 * Query construction for external source discovery (spec 027).
 *
 * The queries are **templated and filled deterministically** rather than
 * written by an agent. An agent that composes its own searches produces a
 * different corpus on every run, and two enrichments of the same client stop
 * being comparable — which would quietly break the one property that makes
 * every other number here defensible.
 *
 * Same identity in, same query list out. The list is stored on the discovery
 * run, so any claim traces back to the question that surfaced the page.
 */
import { normalizeDomain } from "@/lib/knowledge/normalize";

/** Bump when a template changes: old runs keep explaining their own corpus. */
export const DISCOVERY_TEMPLATE_KEY = "external-discovery-v1";

/** Identity a client is searched by. All of it comes from stored records. */
export interface DiscoveryIdentity {
  /** Canonical client name, e.g. "JC Luxury Group". */
  name: string;
  /** Known aliases; an answer naming one of these is still about this client. */
  aliases?: string[];
  /** The client's own domain — excluded from results, see `filter.ts`. */
  domain?: string;
  /** Named principals (founder, team lead) from approved claims or entities. */
  principals?: string[];
  /** Markets the client serves, e.g. ["Jersey City", "Hoboken"]. */
  markets?: string[];
  /** Parent brand or brokerage, when one is an approved claim. */
  affiliation?: string;
}

export interface DiscoveryQuery {
  /** The literal search string. */
  text: string;
  /** Which template produced it — a bad template is traceable from a bad page. */
  template: string;
}

/**
 * Caps. Searches cost money and every returned page becomes a fetch, an
 * extraction and an agent call, so breadth is bounded before it starts rather
 * than trimmed after the spend.
 */
export const MAX_QUERIES_PER_RUN = 12;
const MAX_PRINCIPALS = 2;
const MAX_MARKETS = 3;

/**
 * Templates, in priority order. Earlier entries survive the cap first, so a
 * truncated run keeps the queries most likely to surface identity-bearing
 * pages rather than whichever happened to be generated last.
 *
 * Deliberately absent: anything shaped to find personal records about an
 * individual. This looks for what a business publishes and what publications
 * say about it (spec 027, "Scope boundaries").
 */
const TEMPLATES = [
  { key: "name", build: (i: DiscoveryIdentity) => [`"${i.name}"`] },
  {
    key: "name_affiliation",
    build: (i: DiscoveryIdentity) =>
      i.affiliation ? [`"${i.name}" "${i.affiliation}"`] : [],
  },
  {
    key: "principal",
    build: (i: DiscoveryIdentity) =>
      (i.principals ?? [])
        .slice(0, MAX_PRINCIPALS)
        .map((p) => `"${p}" "${i.name}"`),
  },
  {
    key: "name_market",
    build: (i: DiscoveryIdentity) =>
      (i.markets ?? []).slice(0, MAX_MARKETS).map((m) => `"${i.name}" ${m}`),
  },
  { key: "news", build: (i: DiscoveryIdentity) => [`"${i.name}" news`] },
  { key: "awards", build: (i: DiscoveryIdentity) => [`"${i.name}" award OR recognition`] },
  {
    key: "alias",
    build: (i: DiscoveryIdentity) =>
      (i.aliases ?? [])
        .filter((a) => a.trim().toLowerCase() !== i.name.trim().toLowerCase())
        .slice(0, 2)
        .map((a) => `"${a}"`),
  },
] as const;

/**
 * Build the query list for one client.
 *
 * Deduplicated case-insensitively: aliases and names overlap often enough that
 * without it a run would pay twice for the same search.
 */
export function buildDiscoveryQueries(identity: DiscoveryIdentity): DiscoveryQuery[] {
  const out: DiscoveryQuery[] = [];
  const seen = new Set<string>();

  for (const template of TEMPLATES) {
    for (const text of template.build(identity)) {
      const trimmed = text.trim();
      if (trimmed.length === 0) continue;
      const dedupeKey = trimmed.toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      out.push({ text: trimmed, template: template.key });
      if (out.length >= MAX_QUERIES_PER_RUN) return out;
    }
  }
  return out;
}

/**
 * The instruction wrapped around a query when handed to a search-enabled model.
 *
 * It asks for sources, not for answers. What we want back is the set of pages
 * the model consulted — those become citations, and citations become captures.
 * A model that answers well from memory and cites nothing has told us nothing
 * we can store, which is why the wording insists on browsing.
 *
 * The client's own domain is named as excluded here as well as filtered later:
 * asking for it back and then discarding it wastes a slot in the result set.
 */
export function discoveryPrompt(query: string, ownDomain?: string): string {
  const exclusion = ownDomain
    ? ` Do not include pages from ${normalizeDomain(ownDomain)} — that site is already held.`
    : "";
  return (
    `Search the web for: ${query}\n\n` +
    `List the pages you consulted that contain factual information about this ` +
    `business — coverage, profiles, directories, articles, or official listings.` +
    exclusion +
    `\n\nDo not summarise from memory. If a search returns nothing relevant, say so.`
  );
}
