/**
 * The extractor contract (spec 021).
 *
 * An extractor turns stored bytes into text plus *spans*. Spans are the point:
 * they anchor an excerpt to a location — page 14, sheet "Q3" row 22, CSV row
 * 108, JSON path `results[3].address` — so a claim can cite where in a
 * 200-page document its support lives instead of citing the whole file.
 *
 * `extractorVersion` is recorded on every extraction. Re-extracting with a new
 * version inserts a new row and keeps the old parse readable, so a claim
 * proposed from an earlier parse stays explicable (PRINCIPLES.md #10).
 */

export type ExtractionStatus = "extracted" | "empty" | "failed" | "unsupported";

/** A located region of the source, addressable by a stable string locator. */
export interface ExtractionSpan {
  /** Human-meaningful location, e.g. "page 3", "sheet:Q3!row:22", "row 108". */
  locator: string;
  /** Character offsets into the extracted `text`. */
  start: number;
  end: number;
  /** Optional label — a heading, sheet name, or column set. */
  label?: string;
}

export interface ExtractionResult {
  status: ExtractionStatus;
  text: string;
  /** Parsed shape when the format has one (rows, sheets, JSON tree). */
  structured: unknown;
  spans: ExtractionSpan[];
  /** Set when status is `failed` or `unsupported`. */
  error?: string;
}

export interface Extractor {
  key: string;
  extractorVersion: string;
  /** Mime types this extractor claims, exact match, lowercased. */
  mimeTypes: string[];
  /** Filename extensions it claims, lowercased, without the dot. */
  extensions: string[];
  extract(bytes: Buffer): Promise<ExtractionResult>;
}

/** Convenience for the several extractors that produce one span per unit. */
export function appendSpan(
  spans: ExtractionSpan[],
  text: string,
  chunk: string,
  locator: string,
  label?: string
): string {
  const start = text.length;
  const next = text.length === 0 ? chunk : `${text}\n${chunk}`;
  spans.push({ locator, start: start === 0 ? 0 : start + 1, end: next.length, label });
  return next;
}
