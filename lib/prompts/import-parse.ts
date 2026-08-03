/**
 * Bulk prompt import (spec 035). Two formats, decided deterministically:
 * a first row whose first cell is "text" makes it header-mapped CSV;
 * anything else is plain lines (one prompt per line, commas preserved —
 * real questions contain commas). Rows without a category get the rule
 * classifier's suggestion; a row no rule matches is rejected as "category
 * required", never guessed. Zero valid rows is a failure, not an empty
 * success.
 */
import { ClassifiedError } from "@/lib/errors";
import { PROMPT_CATEGORIES, PROMPT_TEXT_MAX, type PromptCategory } from "@/lib/constants";
import { parseCsv } from "@/lib/knowledge/sources/extractors/text";
import { classifyPrompt, PROMPT_CLASSIFIER_VERSION } from "@/lib/prompts/classify";

export const IMPORT_MAX_ROWS = 200;

export interface ParsedPromptRow {
  line: number;
  text: string;
  category: PromptCategory;
  language: string;
  tier: number | null;
  /** null when the operator supplied the category explicitly. */
  suggestedByRule: string | null;
}

export interface RejectedRow {
  line: number;
  text: string;
  reason: string;
}

export interface PromptImportParse {
  rows: ParsedPromptRow[];
  rejected: RejectedRow[];
  format: "csv" | "lines";
  classifierVersion: string;
}

const CATEGORY_SET = new Set<string>(PROMPT_CATEGORIES);
const HEADER_COLUMNS = new Set(["text", "category", "language", "tier"]);

function buildRow(
  line: number,
  text: string,
  rawCategory: string,
  rawLanguage: string,
  rawTier: string,
  brandNames: string[]
): ParsedPromptRow | RejectedRow {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { line, text, reason: "empty prompt text" };
  if (trimmed.length > PROMPT_TEXT_MAX) {
    return { line, text: trimmed.slice(0, 80), reason: `longer than ${PROMPT_TEXT_MAX} characters` };
  }

  const language = rawLanguage.trim().toLowerCase() || "en";
  if (language.length < 2 || language.length > 8) {
    return { line, text: trimmed, reason: `invalid language "${rawLanguage.trim()}"` };
  }

  let tier: number | null = null;
  if (rawTier.trim().length > 0) {
    const parsed = Number(rawTier.trim());
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 4) {
      return { line, text: trimmed, reason: `invalid tier "${rawTier.trim()}" (1–4)` };
    }
    tier = parsed;
  }

  const explicit = rawCategory.trim().toLowerCase();
  if (explicit.length > 0) {
    if (!CATEGORY_SET.has(explicit)) {
      return { line, text: trimmed, reason: `unknown category "${rawCategory.trim()}"` };
    }
    return {
      line,
      text: trimmed,
      category: explicit as PromptCategory,
      language,
      tier,
      suggestedByRule: null,
    };
  }

  const suggestion = classifyPrompt(trimmed, { brandNames });
  if (!suggestion) {
    return {
      line,
      text: trimmed,
      reason: "category required — no classification rule matched",
    };
  }
  return {
    line,
    text: trimmed,
    category: suggestion.category,
    language,
    tier: tier ?? suggestion.tier,
    suggestedByRule: suggestion.rule,
  };
}

export function parsePromptImport(
  raw: string,
  opts: { brandNames?: string[] } = {}
): PromptImportParse {
  const brandNames = opts.brandNames ?? [];
  const rows: ParsedPromptRow[] = [];
  const rejected: RejectedRow[] = [];

  const csv = parseCsv(raw);
  const firstCell = csv[0]?.[0]?.trim().toLowerCase() ?? "";
  const isCsv = firstCell === "text";

  if (isCsv) {
    const header = (csv[0] ?? []).map((c) => c.trim().toLowerCase());
    const unknown = header.filter((h) => h.length > 0 && !HEADER_COLUMNS.has(h));
    if (unknown.length > 0) {
      throw new ClassifiedError(
        "validation",
        `Unknown header column(s): ${unknown.join(", ")}. Supported: text, category, language, tier.`
      );
    }
    const col = (name: string) => header.indexOf(name);
    const body = csv.slice(1).filter((r) => r.some((c) => c.trim().length > 0));
    if (body.length > IMPORT_MAX_ROWS) {
      throw new ClassifiedError(
        "validation",
        `${body.length} rows exceeds the import cap of ${IMPORT_MAX_ROWS}.`
      );
    }
    body.forEach((cells, i) => {
      const at = (idx: number) => (idx >= 0 ? (cells[idx] ?? "") : "");
      const outcome = buildRow(
        i + 2, // 1-based, after the header
        at(col("text")),
        at(col("category")),
        at(col("language")),
        at(col("tier")),
        brandNames
      );
      if ("reason" in outcome) rejected.push(outcome);
      else rows.push(outcome);
    });
  } else {
    const lines = raw.split(/\r?\n/);
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    if (nonEmpty.length > IMPORT_MAX_ROWS) {
      throw new ClassifiedError(
        "validation",
        `${nonEmpty.length} lines exceeds the import cap of ${IMPORT_MAX_ROWS}.`
      );
    }
    lines.forEach((line, i) => {
      if (line.trim().length === 0) return;
      const outcome = buildRow(i + 1, line, "", "", "", brandNames);
      if ("reason" in outcome) rejected.push(outcome);
      else rows.push(outcome);
    });
  }

  return {
    rows,
    rejected,
    format: isCsv ? "csv" : "lines",
    classifierVersion: PROMPT_CLASSIFIER_VERSION,
  };
}

/** Case- and whitespace-insensitive identity for dedupe. */
export function normalizePromptText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

