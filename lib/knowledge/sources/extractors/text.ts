/**
 * Text-shaped extractors: plain text, Markdown, HTML, CSV and JSON.
 *
 * All five need zero dependencies. HTML tag stripping is deliberately simple —
 * this is extraction for evidence, not rendering, and a regex that removes
 * script/style blocks then tags produces text a human can verify against the
 * stored original. Anything cleverer would need a DOM and would still need the
 * original kept for audit.
 */
import { EXTRACTED_TEXT_MAX_CHARS } from "@/lib/knowledge/constants";
import {
  appendSpan,
  type ExtractionResult,
  type ExtractionSpan,
  type Extractor,
} from "@/lib/knowledge/sources/extractors/types";

function decode(bytes: Buffer): string {
  return bytes.toString("utf8").replace(/^\uFEFF/, "").replace(/\u0000/g, "");
}

function truncate(text: string): string {
  return text.length > EXTRACTED_TEXT_MAX_CHARS
    ? text.slice(0, EXTRACTED_TEXT_MAX_CHARS)
    : text;
}

function result(text: string, structured: unknown, spans: ExtractionSpan[]): ExtractionResult {
  const trimmed = truncate(text).trim();
  return {
    status: trimmed.length === 0 ? "empty" : "extracted",
    text: trimmed,
    structured,
    spans,
  };
}

// ---------------------------------------------------------------- plain text

export const textExtractor: Extractor = {
  key: "text",
  extractorVersion: "text-v1",
  mimeTypes: ["text/plain"],
  extensions: ["txt", "text", "log"],
  async extract(bytes) {
    const text = decode(bytes);
    // One span per paragraph, so an excerpt can name where it came from.
    const spans: ExtractionSpan[] = [];
    let offset = 0;
    let index = 0;
    for (const para of text.split(/\n{2,}/)) {
      if (para.trim().length > 0) {
        spans.push({
          locator: `paragraph ${++index}`,
          start: offset,
          end: offset + para.length,
        });
      }
      offset += para.length + 2;
    }
    return result(text, null, spans);
  },
};

// ------------------------------------------------------------------ markdown

export const markdownExtractor: Extractor = {
  key: "markdown",
  extractorVersion: "markdown-v1",
  mimeTypes: ["text/markdown", "text/x-markdown"],
  extensions: ["md", "markdown"],
  async extract(bytes) {
    const raw = decode(bytes);
    // Sections are the natural span unit in Markdown: a claim cites a heading.
    const spans: ExtractionSpan[] = [];
    const lines = raw.split("\n");
    let offset = 0;
    let currentHeading = "(preamble)";
    let sectionStart = 0;
    const closeSection = (end: number) => {
      if (end > sectionStart) {
        spans.push({
          locator: currentHeading,
          start: sectionStart,
          end,
          label: currentHeading,
        });
      }
    };
    for (const line of lines) {
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        closeSection(offset);
        currentHeading = heading[2]!.trim();
        sectionStart = offset;
      }
      offset += line.length + 1;
    }
    closeSection(raw.length);
    return result(raw, null, spans);
  },
};

// ---------------------------------------------------------------------- html

const BLOCK_CLOSE = /<\/(p|div|section|article|h[1-6]|li|tr|br)\s*>/gi;

export const htmlExtractor: Extractor = {
  key: "html",
  extractorVersion: "html-v1",
  mimeTypes: ["text/html", "application/xhtml+xml"],
  extensions: ["html", "htm"],
  async extract(bytes) {
    const raw = decode(bytes);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.trim() ?? null;
    const metas: Record<string, string> = {};
    for (const match of raw.matchAll(
      /<meta\s+[^>]*name=["']([^"']+)["'][^>]*content=["']([^"']*)["'][^>]*>/gi
    )) {
      metas[match[1]!.toLowerCase()] = match[2]!;
    }
    const body = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(BLOCK_CLOSE, "\n")
      .replace(/<[^>]+>/g, " ");
    const text = decodeEntities(body)
      .replace(/[ \t\u00A0]+/g, " ")
      .replace(/\n\s*\n\s*/g, "\n\n")
      .trim();

    const spans: ExtractionSpan[] = [];
    let offset = 0;
    let index = 0;
    for (const block of text.split(/\n{2,}/)) {
      if (block.trim().length > 0) {
        spans.push({ locator: `block ${++index}`, start: offset, end: offset + block.length });
      }
      offset += block.length + 2;
    }
    return result(text, { title, meta: metas }, spans);
  },
};

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1]?.toLowerCase() === "x"
        ? Number.parseInt(body.slice(2), 16)
        : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

// ----------------------------------------------------------------------- csv

/** RFC 4180 parse: quoted fields, escaped quotes, CRLF or LF row endings. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += ch === "\r" && input[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

/** A first row is a header when every cell is non-empty and non-numeric. */
export function looksLikeHeader(row: string[] | undefined): boolean {
  if (!row || row.length === 0) return false;
  return row.every((cell) => {
    const value = cell.trim();
    return value.length > 0 && Number.isNaN(Number(value));
  });
}

export const csvExtractor: Extractor = {
  key: "csv",
  extractorVersion: "csv-v1",
  mimeTypes: ["text/csv", "application/csv"],
  extensions: ["csv", "tsv"],
  async extract(bytes) {
    const rows = parseCsv(decode(bytes));
    if (rows.length === 0) {
      return { status: "empty", text: "", structured: { headers: [], rows: [] }, spans: [] };
    }
    const hasHeader = looksLikeHeader(rows[0]);
    const headers = hasHeader ? rows[0]!.map((h) => h.trim()) : [];
    const dataRows = hasHeader ? rows.slice(1) : rows;

    const spans: ExtractionSpan[] = [];
    let text = headers.length > 0 ? headers.join(" | ") : "";
    if (headers.length > 0) {
      spans.push({ locator: "header", start: 0, end: text.length, label: "header" });
    }
    const records: Record<string, string>[] = [];
    dataRows.forEach((cells, index) => {
      const line = cells.map((c) => c.trim()).join(" | ");
      text = appendSpan(spans, text, line, `row ${index + 1}`);
      if (headers.length > 0) {
        const record: Record<string, string> = {};
        headers.forEach((h, col) => {
          record[h] = cells[col]?.trim() ?? "";
        });
        records.push(record);
      }
    });
    return result(text, { headers, rows: headers.length > 0 ? records : dataRows }, spans);
  },
};

// ---------------------------------------------------------------------- json

export const jsonExtractor: Extractor = {
  key: "json",
  extractorVersion: "json-v1",
  mimeTypes: ["application/json", "text/json", "application/ld+json"],
  extensions: ["json", "jsonl", "ndjson"],
  async extract(bytes) {
    const raw = decode(bytes).trim();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Newline-delimited JSON is common in export files; try it before failing.
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      try {
        parsed = lines.map((l) => JSON.parse(l));
      } catch (err) {
        return {
          status: "failed",
          text: "",
          structured: null,
          spans: [],
          error: `Not valid JSON or NDJSON: ${(err as Error).message}`,
        };
      }
    }
    // Flatten to `path: value` lines so full-text search and excerpt anchoring
    // both work against a shape that has neither by default.
    const spans: ExtractionSpan[] = [];
    let text = "";
    for (const [path, value] of flatten(parsed)) {
      text = appendSpan(spans, text, `${path}: ${value}`, path);
    }
    return result(text, parsed, spans);
  },
};

function* flatten(value: unknown, path = "$"): Generator<[string, string]> {
  if (value === null || value === undefined) {
    yield [path, "null"];
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) yield* flatten(item, `${path}[${index}]`);
    return;
  }
  if (typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      yield* flatten(item, `${path}.${key}`);
    }
    return;
  }
  yield [path, String(value)];
}
