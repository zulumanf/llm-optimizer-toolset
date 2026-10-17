/**
 * Deterministic structured data from APPROVED facts only (spec 151 B3).
 *
 * Every property comes from one approved claim (keys below); a missing
 * claim means the property is omitted — never inferred, never defaulted.
 * Ratings, reviews, rankings, awards and transaction statistics are not
 * templated at all: they are claims about performance that need their own
 * evidence trail, and fabricated review markup is a search-spam pattern.
 *
 * The output is a SUGGESTION for the client's site; publishing it is a
 * client-website change behind human approval.
 */
export const JSONLD_TEMPLATE_VERSION = "jsonld-template-v1";

/** The approved-claim keys the templates read. */
export const STRUCTURED_DATA_KEYS = {
  name: "business.name",
  url: "business.url",
  telephone: "business.telephone",
  email: "business.email",
  street: "business.address.street",
  locality: "business.address.locality",
  region: "business.address.region",
  postalCode: "business.address.postal_code",
  areaServed: "business.area_served",
  sameAs: "business.same_as",
  foundingYear: "business.founding_year",
  personName: "person.name",
  personJobTitle: "person.job_title",
  brokerage: "person.works_for",
  license: "person.license_number",
} as const;

/** Existing vertical-pack claim keys (lib/verticals/packs.ts, real estate)
 * read as fallbacks, so a client onboarded through the pack needs no second
 * set of claims. */
export const PACK_KEY_FALLBACKS: Partial<Record<keyof typeof STRUCTURED_DATA_KEYS, string>> = {
  brokerage: "brokerage",
  areaServed: "markets_served",
};

export interface ApprovedClaim {
  id: string;
  key: string;
  canonicalText: string;
  value: unknown;
}

export type EntityKind = "agent_business" | "person" | "brokerage";

const SCHEMA_TYPE: Record<EntityKind, string> = {
  agent_business: "RealEstateAgent",
  person: "Person",
  brokerage: "RealEstateAgent",
};

/** Recommended (not required) properties, reported when absent. */
const RECOMMENDED: Record<EntityKind, string[]> = {
  agent_business: ["name", "url", "telephone", "locality", "region", "areaServed", "sameAs"],
  person: ["personName", "personJobTitle", "brokerage", "url", "sameAs"],
  brokerage: ["name", "url", "telephone", "locality", "region", "sameAs"],
};

function scalar(claim: ApprovedClaim | undefined): string | null {
  if (!claim) return null;
  if (typeof claim.value === "string" && claim.value.trim()) return claim.value.trim();
  if (typeof claim.value === "number") return String(claim.value);
  return claim.canonicalText.trim() || null;
}

function list(claim: ApprovedClaim | undefined): string[] {
  if (!claim) return [];
  if (Array.isArray(claim.value)) return claim.value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
  const s = scalar(claim);
  return s ? s.split(/\s*[;\n]\s*/).filter(Boolean) : [];
}

const isHttpUrl = (s: string) => /^https?:\/\/[^\s]+$/i.test(s);

export interface JsonLdResult {
  jsonLd: Record<string, unknown>;
  usedClaimIds: string[];
  missingRecommended: string[];
  rejected: { key: string; reason: string }[];
  templateVersion: string;
}

export function buildStructuredData(kind: EntityKind, claims: ApprovedClaim[]): JsonLdResult {
  const byKey = new Map(claims.map((c) => [c.key, c]));
  const used = new Set<string>();
  const rejected: { key: string; reason: string }[] = [];
  const claimFor = (field: keyof typeof STRUCTURED_DATA_KEYS): ApprovedClaim | undefined => {
    const fallback = PACK_KEY_FALLBACKS[field];
    return byKey.get(STRUCTURED_DATA_KEYS[field]) ?? (fallback ? byKey.get(fallback) : undefined);
  };
  const take = (field: keyof typeof STRUCTURED_DATA_KEYS): string | null => {
    const claim = claimFor(field);
    const v = scalar(claim);
    if (v && claim) used.add(claim.id);
    return v;
  };
  const takeList = (field: keyof typeof STRUCTURED_DATA_KEYS): string[] => {
    const claim = claimFor(field);
    const v = list(claim);
    if (v.length && claim) used.add(claim.id);
    return v;
  };

  const doc: Record<string, unknown> = { "@context": "https://schema.org", "@type": SCHEMA_TYPE[kind] };
  const present = new Set<string>();
  const set = (prop: string, field: string, value: unknown) => {
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0)) return;
    doc[prop] = value;
    present.add(field);
  };

  if (kind === "person") {
    set("name", "personName", take("personName"));
    set("jobTitle", "personJobTitle", take("personJobTitle"));
    const brokerage = take("brokerage");
    if (brokerage) set("worksFor", "brokerage", { "@type": "RealEstateAgent", name: brokerage });
  } else {
    set("name", "name", take("name"));
    set("telephone", "telephone", take("telephone"));
    set("email", "email", take("email"));
    const foundingYear = take("foundingYear");
    if (foundingYear && /^\d{4}$/.test(foundingYear)) set("foundingDate", "foundingYear", foundingYear);
    else if (foundingYear) rejected.push({ key: STRUCTURED_DATA_KEYS.foundingYear, reason: "not a four-digit year" });
    const address = {
      streetAddress: take("street"),
      addressLocality: take("locality"),
      addressRegion: take("region"),
      postalCode: take("postalCode"),
    };
    if (address.addressLocality) present.add("locality");
    if (address.addressRegion) present.add("region");
    const filled = Object.fromEntries(Object.entries(address).filter(([, v]) => v));
    if (Object.keys(filled).length > 0) doc.address = { "@type": "PostalAddress", ...filled };
    const areas = takeList("areaServed");
    set("areaServed", "areaServed", areas.length === 1 ? areas[0] : areas);
  }

  const url = take("url");
  if (url && isHttpUrl(url)) set("url", "url", url);
  else if (url) rejected.push({ key: STRUCTURED_DATA_KEYS.url, reason: "not an http(s) URL" });
  const sameAs = takeList("sameAs");
  const goodSameAs = sameAs.filter(isHttpUrl);
  if (goodSameAs.length < sameAs.length) rejected.push({ key: STRUCTURED_DATA_KEYS.sameAs, reason: "non-URL entries dropped" });
  set("sameAs", "sameAs", goodSameAs);

  return {
    jsonLd: doc,
    usedClaimIds: [...used].sort(),
    missingRecommended: RECOMMENDED[kind].filter((f) => !present.has(f)).map((f) => STRUCTURED_DATA_KEYS[f as keyof typeof STRUCTURED_DATA_KEYS]),
    rejected,
    templateVersion: JSONLD_TEMPLATE_VERSION,
  };
}
