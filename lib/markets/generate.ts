/**
 * Deterministic prompt generation from market packs (spec 040). Pure
 * expansion first (same pack + options → identical output, no LLM), then a
 * service that inserts through the normal prompt path with lineage — never
 * duplicating a text already in the set. Truncation by the cap is reported,
 * never silent.
 */
import { z } from "zod";
import { sql } from "@/db/client";
import { assertCanWrite, type CurrentUser } from "@/lib/auth";
import { ClassifiedError } from "@/lib/errors";
import { ok, fail, type ActionResult } from "@/lib/actions/result";
import { addPrompt } from "@/lib/prompts/prompt-service";
import { getMarketPack } from "@/lib/markets/packs";
import type { GeoNode, MarketPackDefinition } from "@/lib/markets/types";

export const MAX_MARKET_PROMPTS = 60;

export interface GeneratedPrompt {
  text: string;
  category: string;
  tier: number;
  audience: string;
  priceTier: string | null;
  templateRef: string;
  /** Structured dimensions (spec 087): known exactly at substitution time,
   * so they are stamped as columns instead of living only in the text. */
  neighborhood: string | null;
  propertyType: string | null;
}

export interface ExpansionResult {
  prompts: GeneratedPrompt[];
  /** Combinations dropped by the cap — reported, never silent. */
  skippedByCap: number;
  /** Neighborhoods excluded with their reasons (from the pack). */
  excluded: { name: string; reason: string }[];
}

/** All neighborhood names in the pack's hierarchy, in tree order. */
export function packNeighborhoods(pack: MarketPackDefinition): string[] {
  const out: string[] = [];
  const walk = (node: GeoNode): void => {
    if (node.kind === "neighborhood") out.push(node.name);
    for (const child of node.children ?? []) walk(child);
  };
  walk(pack.hierarchy);
  return out;
}

/** "{city}" as an assistant would need to hear it. Ambiguous city names
 * (Wilmington DE vs NC, Portland, Springfield…) must carry their state, or
 * both discovery and the benchmark silently measure the wrong market —
 * found live 2026-08-21 when "Wilmington" returned North Carolina teams.
 * The pack's hierarchy root is the state/region; it qualifies the city
 * whenever it is not the city itself. */
export function placeLabel(pack: Pick<MarketPackDefinition, "cityName" | "hierarchy">): string {
  const root = pack.hierarchy;
  if (root.kind === "region" && root.name.trim().toLowerCase() !== pack.cityName.trim().toLowerCase()) {
    return `${pack.cityName}, ${root.name}`;
  }
  return pack.cityName;
}

export function expandMarketPack(
  pack: MarketPackDefinition,
  options: { templateKeys?: string[]; neighborhoods?: string[]; cap?: number } = {}
): ExpansionResult {
  const cap = Math.min(options.cap ?? MAX_MARKET_PROMPTS, 200);
  const excludedNames = new Set(pack.excludedPlaceNames.map((e) => e.name));
  const allNeighborhoods = packNeighborhoods(pack).filter((n) => !excludedNames.has(n));
  const neighborhoods = options.neighborhoods
    ? allNeighborhoods.filter((n) => options.neighborhoods!.includes(n))
    : allNeighborhoods;
  const templates = options.templateKeys
    ? pack.templates.filter((t) => options.templateKeys!.includes(t.key))
    : pack.templates;

  const prompts: GeneratedPrompt[] = [];
  let skippedByCap = 0;
  const push = (p: GeneratedPrompt): void => {
    if (prompts.length >= cap) skippedByCap += 1;
    else prompts.push(p);
  };

  const place = placeLabel(pack);
  for (const template of templates) {
    const areas = template.scope === "city" ? [place] : neighborhoods;
    const propertyTypes =
      template.expand === "propertyType"
        ? pack.propertyTypes
        : template.expand === "primaryPropertyType"
          ? pack.primaryPropertyTypes
          : [null];
    const priceTiers = template.expand === "priceTier" ? pack.priceTiers : [null];
    for (const area of areas) {
      for (const propertyType of propertyTypes) {
        for (const priceTier of priceTiers) {
          const text = template.text
            .replaceAll("{city}", place)
            .replaceAll("{area}", area)
            .replaceAll("a {propertyType}", withArticle(singular(propertyType ?? "")))
            .replaceAll("{propertyType}", propertyType ?? "")
            .replaceAll("{priceTier}", priceTier ?? "")
            .replace(/\s+/g, " ")
            .trim();
          push({
            text,
            category: template.category,
            tier: template.tier,
            audience: template.audience,
            priceTier,
            templateRef: `${pack.key}@v${pack.version}:${template.key}`,
            neighborhood: template.scope === "city" ? null : area,
            propertyType,
          });
        }
      }
    }
  }
  return { prompts, skippedByCap, excluded: pack.excludedPlaceNames };
}

export interface GenerationReport {
  created: number;
  skippedExisting: number;
  skippedByCap: number;
  excluded: { name: string; reason: string }[];
}

/** Expand a pack into a prompt set. Idempotent per text: prompts whose text
 * already exists in the set (case-insensitive, active) are skipped. */
export async function generateMarketPrompts(
  user: CurrentUser,
  raw: unknown
): Promise<ActionResult<GenerationReport>> {
  const parsed = z
    .object({
      setId: z.string().uuid(),
      packKey: z.string().min(1),
      templateKeys: z.array(z.string()).optional(),
      neighborhoods: z.array(z.string()).optional(),
      cap: z.number().int().positive().max(200).optional(),
    })
    .safeParse(raw);
  if (!parsed.success) {
    return fail(new ClassifiedError("validation", "Invalid generation request."));
  }
  const input = parsed.data;
  const pack = getMarketPack(input.packKey);
  if (!pack) {
    return fail(new ClassifiedError("not_found", `Unknown market pack "${input.packKey}".`));
  }
  try {
    assertCanWrite(user);
    const expansion = expandMarketPack(pack, input);
    const existing = await sql`
      select lower(text) as text from prompts
      where prompt_set_id = ${input.setId} and archived_at is null
    `;
    const seen = new Set(existing.map((r) => r.text as string));
    let created = 0;
    let skippedExisting = 0;
    for (const prompt of expansion.prompts) {
      if (seen.has(prompt.text.toLowerCase())) {
        skippedExisting += 1;
        continue;
      }
      const result = await addPrompt(user, {
        setId: input.setId,
        text: prompt.text,
        category: prompt.category,
        tier: prompt.tier,
        source: "expansion",
        audience: prompt.audience,
        priceTier: prompt.priceTier ?? undefined,
        templateRef: prompt.templateRef,
        neighborhood: prompt.neighborhood ?? undefined,
        propertyType: prompt.propertyType ?? undefined,
      });
      if (!result.ok) {
        return fail(new ClassifiedError("internal", `Prompt insert failed: ${result.error.message}`));
      }
      seen.add(prompt.text.toLowerCase());
      created += 1;
    }
    return ok({
      created,
      skippedExisting,
      skippedByCap: expansion.skippedByCap,
      excluded: expansion.excluded,
    });
  } catch (err) {
    return fail(err);
  }
}

/** "condominiums" → "condominium", "single-family homes" → "single-family
 * home", "townhomes" → "townhome". Packs may list plural property types; a
 * seller question reads "sell a condominium", never "sell a condominiums"
 * (found live in the Raleigh run, spec 128). */
export function singular(term: string): string {
  const t = term.trim();
  if (/\b(ies)$/i.test(t)) return t.replace(/ies$/i, "y");
  if (/(ses|xes|ches|shes)$/i.test(t)) return t.replace(/es$/i, "");
  if (/[^s]s$/i.test(t)) return t.replace(/s$/i, "");
  return t;
}

export function withArticle(term: string): string {
  const t = term.trim();
  if (!t) return "";
  return `${/^[aeiou]/i.test(t) ? "an" : "a"} ${t}`;
}

