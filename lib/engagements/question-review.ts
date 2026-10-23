/**
 * Client-reviewed question set validation (spec 154). Pure.
 *
 * Input is the CSV export of a client review sheet: one question per row,
 * optional segment columns and the client's per-question decision. Preamble
 * rows above the header (titles, instructions) are skipped. Nothing here is
 * client-specific: the engagement supplies the price floor and the names
 * that make a question "branded".
 */
import { parseCsv } from "@/lib/knowledge/sources/extractors/text";
import { PROMPT_CATEGORIES, PROMPT_TEXT_MAX, type PromptCategory } from "@/lib/constants";
import { normalizePromptText } from "@/lib/prompts/import-parse";
import { scanAliases, type CompanyAliases } from "@/lib/parsing/prepass";
import { moneyMentions, parsePriceBand } from "@/lib/engagements/delivery-rules";

export const QUESTION_REVIEW_VERSION = "question-review-v1";
export const QUESTION_IMPORT_MAX_ROWS = 300;

export const ROW_DECISIONS = ["pending", "approved", "revise", "remove", "check_service_area"] as const;
export type RowDecision = (typeof ROW_DECISIONS)[number];

/** Seller-intent wording. A question without it is a warning, not a block:
 * "who should I hire to get top dollar for my house" is still seller intent. */
const SELLER_INTENT = /\b(sell|selling|seller|sellers|list|listing|listings|top dollar|market my (?:home|house))\b/i;

const HEADER_ALIASES: Record<string, string[]> = {
  text: ["text", "question", "prompt", "seller question", "query"],
  priceTier: ["price_tier", "price tier", "segment", "price band", "price_band", "band"],
  neighborhood: ["neighborhood", "neighbourhood", "area", "community", "location"],
  audience: ["audience", "intent"],
  propertyType: ["property_type", "property type"],
  category: ["category"],
  decision: ["client_decision", "decision"],
  comment: ["client_comment", "comment", "comments"],
};

export interface ReviewedQuestion {
  line: number;
  text: string;
  category: PromptCategory;
  priceTier: string | null;
  neighborhood: string | null;
  audience: string | null;
  propertyType: string | null;
  decision: RowDecision;
  comment: string | null;
}

export interface ReviewIssue {
  line: number;
  severity: "blocking" | "warning";
  message: string;
  text: string;
}

export interface QuestionReview {
  version: string;
  rows: ReviewedQuestion[];
  excluded: ReviewedQuestion[];
  issues: ReviewIssue[];
  segments: { priceTier: string; count: number }[];
  ok: boolean;
}

export interface ReviewOptions {
  /** Engagement minimum estimated property value (USD); null = no floor. */
  minPropertyValueUsd: number | null;
  /** Names that make a question branded: subject, tracked competitors, aliases. */
  brands: CompanyAliases[];
  /** Warn when a question shows no seller intent. */
  requireSellerIntent: boolean;
  defaultAudience: string | null;
}

function headerKey(cell: string): string | null {
  const c = cell.trim().toLowerCase();
  for (const [key, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(c)) return key;
    if (key === "decision" && c.endsWith(" decision")) return key;
    if (key === "comment" && (c.includes("comment") || c.endsWith(" edits"))) return key;
  }
  return null;
}

export function normalizeDecision(raw: string): RowDecision | null {
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (v === "" || v === "pending") return "pending";
  if (v === "approved" || v === "approve" || v === "ok" || v === "yes") return "approved";
  if (v === "revise" || v === "revision" || v === "edit") return "revise";
  if (v === "remove" || v === "removed" || v === "delete" || v === "no") return "remove";
  if (v === "check_service_area" || v === "check_area") return "check_service_area";
  return null;
}

export function reviewQuestionCsv(raw: string, opts: ReviewOptions): QuestionReview {
  const table = parseCsv(raw);
  const headerIdx = table.findIndex((row) => row.some((c) => headerKey(c) === "text"));
  const issues: ReviewIssue[] = [];
  const rows: ReviewedQuestion[] = [];
  const excluded: ReviewedQuestion[] = [];
  if (headerIdx === -1) {
    issues.push({ line: 1, severity: "blocking", message: "No header row with a question/text column was found.", text: "" });
    return { version: QUESTION_REVIEW_VERSION, rows, excluded, issues, segments: [], ok: false };
  }
  const header = table[headerIdx]!.map(headerKey);
  const col = (key: string) => header.indexOf(key);
  const body = table.slice(headerIdx + 1);
  const nonEmpty = body.filter((r) => r.some((c) => c.trim().length > 0));
  if (nonEmpty.length > QUESTION_IMPORT_MAX_ROWS) {
    issues.push({ line: headerIdx + 1, severity: "blocking", message: `${nonEmpty.length} rows exceeds the cap of ${QUESTION_IMPORT_MAX_ROWS}.`, text: "" });
    return { version: QUESTION_REVIEW_VERSION, rows, excluded, issues, segments: [], ok: false };
  }
  const seen = new Map<string, number>();
  body.forEach((cells, i) => {
    const line = headerIdx + i + 2;
    const at = (key: string) => {
      const idx = col(key);
      return idx >= 0 ? (cells[idx] ?? "").trim() : "";
    };
    const text = at("text").replace(/\s+/g, " ");
    if (!cells.some((c) => c.trim().length > 0)) return;
    const block = (message: string) => issues.push({ line, severity: "blocking", message, text });
    const warn = (message: string) => issues.push({ line, severity: "warning", message, text });
    if (text.length === 0) {
      // Section/subtotal rows in a sheet export carry no question text.
      if (at("decision") || at("priceTier")) warn("Row has no question text; skipped.");
      return;
    }
    const decision = normalizeDecision(at("decision"));
    const rawCategory = at("category").toLowerCase();
    const category = (rawCategory || "recommendation") as PromptCategory;
    const row: ReviewedQuestion = {
      line,
      text,
      category,
      priceTier: at("priceTier") || null,
      neighborhood: at("neighborhood") || null,
      audience: at("audience") || opts.defaultAudience,
      propertyType: at("propertyType") || null,
      decision: decision ?? "pending",
      comment: at("comment") || null,
    };
    if (decision === null) {
      block(`Unknown client decision "${at("decision")}". Use approved, revise, remove, pending or check service area.`);
      return;
    }
    if (decision === "remove") {
      excluded.push(row);
      return;
    }
    if (decision === "revise") block(`The client asked for a revision${row.comment ? ` ("${row.comment}")` : ""}. Put the agreed wording in the text and mark it approved or pending.`);
    if (decision === "check_service_area") block("The client has not confirmed this area is in scope. Resolve it with the client first.");
    if (!(PROMPT_CATEGORIES as readonly string[]).includes(category)) block(`Unknown category "${rawCategory}".`);
    if (category === "branded") block("Branded questions are not part of a client measurement set.");
    if (text.length > PROMPT_TEXT_MAX) block(`Longer than ${PROMPT_TEXT_MAX} characters.`);
    const key = normalizePromptText(text);
    const firstLine = seen.get(key);
    if (firstLine !== undefined) block(`Duplicate of line ${firstLine}.`);
    else seen.set(key, line);
    const hits = scanAliases(text, opts.brands);
    if (hits.length > 0) block(`Names ${hits.map((h) => `"${h.matched}"`).join(", ")} — measurement questions must not name the client or a competitor.`);
    if (opts.requireSellerIntent && !SELLER_INTENT.test(text)) warn("No seller-intent wording (sell, list, listing agent…). Confirm this is a seller question.");
    if (opts.minPropertyValueUsd !== null) {
      const floor = opts.minPropertyValueUsd;
      const band = row.priceTier ? parsePriceBand(row.priceTier) : null;
      if (row.priceTier && !band) warn(`Price band "${row.priceTier}" could not be read; the ${floor.toLocaleString("en-US")} USD floor was not checked against it.`);
      if (!row.priceTier) warn("No price band; the property-value floor was not checked against a band.");
      if (band && band.min < floor) block(`Price band starts below the agreed minimum of $${floor.toLocaleString("en-US")}.`);
      const low = moneyMentions(text).filter((v) => v > 0 && v < floor);
      if (low.length > 0) block(`Mentions $${low[0]!.toLocaleString("en-US")}, below the agreed minimum of $${floor.toLocaleString("en-US")}.`);
    }
    rows.push(row);
  });
  if (rows.length === 0 && !issues.some((x) => x.severity === "blocking")) {
    issues.push({ line: headerIdx + 1, severity: "blocking", message: "No importable questions.", text: "" });
  }
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.priceTier ?? "Unspecified", (counts.get(r.priceTier ?? "Unspecified") ?? 0) + 1);
  return {
    version: QUESTION_REVIEW_VERSION,
    rows,
    excluded,
    issues,
    segments: [...counts.entries()].map(([priceTier, count]) => ({ priceTier, count })),
    ok: !issues.some((x) => x.severity === "blocking"),
  };
}

/** Spec 155: how the client sees questions grouped (price tier, then audience). */
export const OTHER_SEGMENT = "Other questions";

export function segmentOf(q: { priceTier: string | null; audience: string | null }): string {
  return q.priceTier?.trim() || q.audience?.trim() || OTHER_SEGMENT;
}
