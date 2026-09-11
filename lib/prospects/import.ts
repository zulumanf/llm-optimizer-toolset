/**
 * CSV import of leading-team lists (spec 032 Phase 2.2). Pure parsing —
 * the service persists. Minimal RFC-4180 handling: quoted fields, escaped
 * quotes (""), CR/LF line ends. No dependency: the inputs are small,
 * operator-curated lists, capped well below anything a streaming parser
 * would earn its keep on.
 */

import { parseCsv as parseCsvRows } from "@/lib/knowledge/sources/extractors/text";

export const IMPORT_ROW_CAP = 200;

/**
 * Tokenize one CSV text into rows of fields — the shared RFC-4180 parser
 * (lib/knowledge/sources/extractors/text.ts; cleanup 2026-08-18 removed
 * this file's byte-equivalent copy), plus the import-specific rule: rows
 * that are entirely empty (trailing newlines, spacer lines) are dropped.
 */
export function parseCsv(text: string): string[][] {
  return parseCsvRows(text).filter((r) => r.some((f) => f.trim().length > 0));
}

/** Header → canonical field. Case-, space- and underscore-insensitive. */
const HEADER_MAP: Record<string, string> = {
  businessname: "businessName",
  name: "businessName",
  team: "businessName",
  prospecttype: "prospectType",
  type: "prospectType",
  teamleader: "teamLeader",
  leader: "teamLeader",
  brokerage: "brokerageAffiliation",
  brokerageaffiliation: "brokerageAffiliation",
  website: "website",
  url: "website",
  email: "email",
  phone: "phone",
  pricesegment: "priceSegment",
  contactname: "contactName",
  contactrole: "contactRole",
  contactemail: "contactEmail",
};

export interface ImportRow {
  line: number;
  businessName: string;
  prospectType?: string;
  teamLeader?: string;
  brokerageAffiliation?: string;
  website?: string;
  email?: string;
  phone?: string;
  priceSegment?: string;
  contactName?: string;
  contactRole?: string;
  contactEmail?: string;
}

export interface ParsedImport {
  rows: ImportRow[];
  errors: { line: number; message: string }[];
  /** Headers present in the file that the importer does not understand. */
  ignoredHeaders: string[];
}

const normalizeHeader = (h: string): string =>
  h.toLowerCase().replace(/[\s_-]/g, "");

/**
 * Parse a pasted CSV with a header row into prospect import rows. Line
 * numbers are 1-based against the original file (header = line 1).
 */
export function parseProspectImport(text: string): ParsedImport {
  const raw = parseCsv(text);
  if (raw.length === 0) {
    return { rows: [], errors: [{ line: 1, message: "The file is empty." }], ignoredHeaders: [] };
  }
  const header = raw[0]!.map(normalizeHeader);
  const mapped = header.map((h) => HEADER_MAP[h] ?? null);
  const ignoredHeaders = raw[0]!.filter((_, i) => mapped[i] === null).map((h) => h.trim());
  if (!mapped.includes("businessName")) {
    return {
      rows: [],
      errors: [
        {
          line: 1,
          message:
            'A "business_name" (or "name" / "team") column is required.',
        },
      ],
      ignoredHeaders,
    };
  }

  const rows: ImportRow[] = [];
  const errors: { line: number; message: string }[] = [];
  const body = raw.slice(1, 1 + IMPORT_ROW_CAP);
  if (raw.length - 1 > IMPORT_ROW_CAP) {
    errors.push({
      line: IMPORT_ROW_CAP + 2,
      message: `Import is capped at ${IMPORT_ROW_CAP} rows per file; the rest were ignored.`,
    });
  }
  body.forEach((fields, index) => {
    const line = index + 2;
    const row: Record<string, string> = {};
    mapped.forEach((key, col) => {
      if (!key) return;
      const value = (fields[col] ?? "").trim();
      if (value) row[key] = value;
    });
    if (!row.businessName) {
      errors.push({ line, message: "Missing business name." });
      return;
    }
    rows.push({ line, ...row } as ImportRow);
  });
  return { rows, errors, ignoredHeaders };
}
