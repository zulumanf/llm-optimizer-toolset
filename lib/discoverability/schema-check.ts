/**
 * Structured-data validation (spec 088, schema-check-v1). JSON-LD blocks
 * against the types that matter for real-estate machine understanding —
 * nothing else. Schema is ONE machine-understanding signal, never a ranking
 * guarantee, and this module never invents values: it reports what is there
 * and what is not.
 */
import { SCHEMA_CHECK_VERSION } from "@/lib/discoverability/constants";

export { SCHEMA_CHECK_VERSION };

/** Types we care about; anything else is out of scope, not a finding. */
export const RELEVANT_TYPES = [
  "Person",
  "Organization",
  "RealEstateAgent",
  "LocalBusiness",
  "WebSite",
  "WebPage",
  "BreadcrumbList",
  "Article",
  "FAQPage",
] as const;

/** Entity-bearing types — the ones whose absence on a team/agent page is an
 * entity-representation gap. */
export const ENTITY_TYPES: ReadonlySet<string> = new Set([
  "Person",
  "Organization",
  "RealEstateAgent",
  "LocalBusiness",
]);

/** Recommended (not required) properties per entity type. Their absence is
 * "incomplete", never "invalid". */
const RECOMMENDED_PROPS: Record<string, string[]> = {
  Person: ["name", "url", "sameAs", "worksFor", "image"],
  Organization: ["name", "url", "sameAs", "address"],
  RealEstateAgent: ["name", "url", "address", "areaServed", "telephone", "image"],
  LocalBusiness: ["name", "url", "address", "telephone", "image"],
};

export type SchemaFindingKind =
  | "missing"
  | "invalid"
  | "inconsistent"
  | "incomplete"
  | "informational";

export interface SchemaObservation {
  kind: SchemaFindingKind;
  type: string | null;
  /** What was observed — exact, reproducible. */
  observed: Record<string, unknown>;
  note: string;
}

function typesOf(block: Record<string, unknown>): string[] {
  const raw = block["@type"];
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((t): t is string => typeof t === "string");
  return [];
}

function present(block: Record<string, unknown>, prop: string): boolean {
  const value = block[prop];
  if (value == null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/**
 * Evaluate one page's JSON-LD blocks.
 *
 * - `expectEntity`: the page kind implies the client entity should be
 *   machine-readable here (team/agent/homepage) — absence becomes "missing".
 * - `subjectNames`: the client's known name + aliases; a defined entity name
 *   containing none of them is flagged "inconsistent" (observed value
 *   retained, no correction invented).
 */
export function checkStructuredData(input: {
  blocks: Record<string, unknown>[];
  parseError: string | null;
  expectEntity: boolean;
  subjectNames: string[];
}): SchemaObservation[] {
  const observations: SchemaObservation[] = [];

  if (input.parseError) {
    observations.push({
      kind: "invalid",
      type: null,
      observed: { parseError: input.parseError },
      note: "A JSON-LD block is present but does not parse as JSON.",
    });
  }

  const relevant = input.blocks
    .map((block) => ({ block, types: typesOf(block) }))
    .filter(({ types }) => types.some((t) => (RELEVANT_TYPES as readonly string[]).includes(t)));

  const entityBlocks = relevant.filter(({ types }) =>
    types.some((t) => ENTITY_TYPES.has(t))
  );

  if (input.expectEntity && entityBlocks.length === 0) {
    observations.push({
      kind: "missing",
      type: null,
      observed: {
        blocksFound: input.blocks.length,
        relevantTypesFound: relevant.flatMap(({ types }) => types),
      },
      note:
        "No Person/Organization/RealEstateAgent/LocalBusiness structured " +
        "data was found on a page that represents the entity.",
    });
  }

  for (const { block, types } of entityBlocks) {
    const entityType = types.find((t) => ENTITY_TYPES.has(t))!;
    const recommended = RECOMMENDED_PROPS[entityType] ?? [];
    const absent = recommended.filter((prop) => !present(block, prop));
    const name = typeof block.name === "string" ? block.name : null;

    if (
      name &&
      input.subjectNames.length > 0 &&
      !input.subjectNames.some((candidate) =>
        name.toLowerCase().includes(candidate.toLowerCase())
      )
    ) {
      observations.push({
        kind: "inconsistent",
        type: entityType,
        observed: { name, expectedOneOf: input.subjectNames },
        note: `The ${entityType} block's name does not match any known name for the client.`,
      });
    }

    if (absent.length > 0) {
      observations.push({
        kind: "incomplete",
        type: entityType,
        observed: {
          name,
          absentRecommendedProps: absent,
          presentProps: recommended.filter((prop) => present(block, prop)),
        },
        note: `${entityType} structured data is present but omits recommended properties: ${absent.join(", ")}.`,
      });
    } else {
      observations.push({
        kind: "informational",
        type: entityType,
        observed: { name },
        note: `${entityType} structured data is present with the recommended properties.`,
      });
    }
  }

  return observations;
}
