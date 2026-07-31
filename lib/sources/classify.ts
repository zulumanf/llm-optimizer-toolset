/**
 * Deterministic source classification v1 (roadmap 2.2). Domain lists, not a
 * model: a wrong deterministic label is debuggable and fixable in one place;
 * a wrong model label is a mood. LLM-assisted classification for the long
 * tail is a recorded follow-up — it must not launch without a validation
 * set, per docs/12.
 *
 * relationship is project-relative (owned = the subject's domain,
 * competitor = a tracked competitor's domain); source_type is global.
 */

export const SOURCE_CLASSIFIER_VERSION = "source-classifier-v1";

export type SourceType =
  | "client_site"
  | "brokerage"
  | "portal"
  | "news"
  | "directory"
  | "social"
  | "video"
  | "review"
  | "government"
  | "other";

export type SourceRelationship = "owned" | "competitor" | "third_party";

const PORTALS = [
  "zillow.com",
  "streeteasy.com",
  "realtor.com",
  "trulia.com",
  "apartments.com",
  "redfin.com",
  "homes.com",
];

/** Large brokerage brand sites — distinct from portals because appearing on
 * one usually means a competitor's page, not a neutral listing. */
const BROKERAGES = ["compass.com", "corcoran.com", "elliman.com", "sothebysrealty.com"];

const SOCIAL = [
  "facebook.com",
  "instagram.com",
  "linkedin.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "threads.net",
  "reddit.com",
];

const VIDEO = ["youtube.com", "youtu.be", "vimeo.com"];

const REVIEW = ["yelp.com", "trustpilot.com", "g2.com", "glassdoor.com"];

const NEWS = [
  "nytimes.com",
  "wsj.com",
  "bloomberg.com",
  "curbed.com",
  "therealdeal.com",
  "brownstoner.com",
  "6sqft.com",
  "brickunderground.com",
  "forbes.com",
  "businessinsider.com",
  "cnbc.com",
];

const DIRECTORY = ["yellowpages.com", "bbb.org", "yext.com", "foursquare.com"];

function inList(domain: string, list: string[]): boolean {
  return list.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export interface ClassificationContext {
  subjectDomain: string | null;
  competitorDomains: string[];
}

export interface SourceClassification {
  sourceType: SourceType;
  relationship: SourceRelationship;
}

export function classifySource(
  domain: string,
  context: ClassificationContext
): SourceClassification {
  const normalized = domain.toLowerCase();

  const owned =
    context.subjectDomain !== null &&
    (normalized === context.subjectDomain ||
      normalized.endsWith(`.${context.subjectDomain}`));
  const competitor =
    !owned &&
    context.competitorDomains.some(
      (d) => normalized === d || normalized.endsWith(`.${d}`)
    );
  const relationship: SourceRelationship = owned
    ? "owned"
    : competitor
      ? "competitor"
      : "third_party";

  let sourceType: SourceType;
  if (owned) sourceType = "client_site";
  else if (normalized.endsWith(".gov")) sourceType = "government";
  else if (inList(normalized, VIDEO)) sourceType = "video";
  else if (inList(normalized, SOCIAL)) sourceType = "social";
  else if (inList(normalized, REVIEW)) sourceType = "review";
  else if (inList(normalized, NEWS)) sourceType = "news";
  else if (inList(normalized, DIRECTORY)) sourceType = "directory";
  else if (inList(normalized, BROKERAGES)) sourceType = "brokerage";
  else if (inList(normalized, PORTALS)) sourceType = "portal";
  else if (competitor) sourceType = "brokerage";
  else sourceType = "other";

  return { sourceType, relationship };
}
