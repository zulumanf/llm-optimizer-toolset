/**
 * Market-pack shapes (spec 040). A pack is everything that changes between
 * cities — geography, neighborhoods, property vocabulary, price tiers,
 * segments, local publications, prompt templates — so onboarding Miami and
 * onboarding Boston are the same operation with different data, never
 * different code. The vertical-pack philosophy (spec 012), applied to place.
 */
import type { PromptCategory } from "@/lib/constants";
import type { IntentTier } from "@/lib/verticals/types";
import type { MarketKind } from "@/lib/exclusivity/constants";

/** One node of a pack's geography, installed into the `markets` tree. */
export interface GeoNode {
  name: string;
  kind: MarketKind;
  aliases?: string[];
  children?: GeoNode[];
}

export type PromptAudience = "buyer" | "seller" | "investor" | "general";

export interface MarketPromptTemplate {
  /** Stable key — part of every generated prompt's template_ref. */
  key: string;
  /** Placeholders: {city}, {area}, {propertyType}, {priceTier}. */
  text: string;
  category: PromptCategory;
  tier: IntentTier;
  audience: PromptAudience;
  /** city → expands once for the city; neighborhood → once per neighborhood
   * (exclusions honored). */
  scope: "city" | "neighborhood";
  /** Optional combinatorial axis. `primaryPropertyType` uses the pack's
   * short primary list so neighborhood × type stays proportionate. */
  expand?: "propertyType" | "primaryPropertyType" | "priceTier";
}

export interface MarketPackDefinition {
  key: string;
  version: number;
  /** Display name used for {city} in templates. */
  cityName: string;
  hierarchy: GeoNode;
  /** Reference data for filtering and future prompting — deliberately not
   * materialized as market rows (spec 040 §2). */
  zipCodes: string[];
  propertyTypes: string[];
  /** Subset of propertyTypes used for neighborhood-level expansion. */
  primaryPropertyTypes: string[];
  priceTiers: string[];
  buyerSegments: string[];
  sellerSegments: string[];
  /** Local vocabulary worth knowing when writing or reviewing prompts. */
  terminology: Record<string, string>;
  /** Prominent local brokerages — competitor-research starting points. */
  brokerages: string[];
  /** Local publications — third-party opportunity starting points. */
  publications: string[];
  /** Neighborhoods that stay in the hierarchy but are excluded from prompt
   * expansion, each with the reason. */
  excludedPlaceNames: { name: string; reason: string }[];
  templates: MarketPromptTemplate[];
}
