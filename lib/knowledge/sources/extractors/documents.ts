/**
 * Binary document extractors: PDF and Excel workbooks.
 *
 * Both dependencies are imported lazily. They are the only heavy packages in
 * this layer, they are needed on a minority of ingests, and a dynamic import
 * keeps them out of the cold path of every request that merely reads a claim.
 * It also means a missing or broken install degrades to `unsupported` with an
 * explicit reason rather than crashing the ingestion pipeline.
 *
 * Package choices are recorded in DECISIONS.md:
 *  - `unpdf` for PDF — no native binaries, ships the pdf.js text layer.
 *  - `read-excel-file` for xlsx — read-only, which is all we need; `exceljs`
 *    was rejected because its write path drags in 95 packages and seven audit
 *    findings for a capability this layer never uses.
 *
 * Neither performs OCR. A scanned PDF yields no text layer and is reported as
 * `empty`, not silently as a successful extraction of nothing.
 */
import { appendSpan, type ExtractionResult, type ExtractionSpan, type Extractor } from "@/lib/knowledge/sources/extractors/types";

// ----------------------------------------------------------------------- pdf

export const pdfExtractor: Extractor = {
  key: "pdf",
  extractorVersion: "pdf-unpdf-v1",
  mimeTypes: ["application/pdf"],
  extensions: ["pdf"],
  async extract(bytes): Promise<ExtractionResult> {
    let pages: string[];
    let meta: unknown = null;
    try {
      const { extractText, getDocumentProxy, getMeta } = await import("unpdf");
      // A fresh Uint8Array: pdf.js takes ownership of the buffer it is handed.
      const proxy = await getDocumentProxy(new Uint8Array(bytes));
      const extracted = await extractText(proxy, { mergePages: false });
      pages = Array.isArray(extracted.text) ? extracted.text : [String(extracted.text)];
      meta = await getMeta(proxy).catch(() => null);
    } catch (err) {
      return {
        status: "failed",
        text: "",
        structured: null,
        spans: [],
        error: `PDF extraction failed: ${(err as Error).message}`,
      };
    }

    const spans: ExtractionSpan[] = [];
    let text = "";
    pages.forEach((page, index) => {
      const body = page.trim();
      if (body.length === 0) return;
      text = appendSpan(spans, text, body, `page ${index + 1}`);
    });

    if (text.trim().length === 0) {
      return {
        status: "empty",
        text: "",
        structured: { pageCount: pages.length, meta },
        spans: [],
        // Said plainly, because "0 claims found" and "this file has no text
        // layer" are different problems with different fixes.
        error:
          "The PDF has no extractable text layer (it is likely a scan). No OCR is performed.",
      };
    }
    return {
      status: "extracted",
      text,
      structured: { pageCount: pages.length, meta },
      spans,
    };
  },
};

// ---------------------------------------------------------------------- xlsx

const XLSX_MIME = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
];

export const xlsxExtractor: Extractor = {
  key: "xlsx",
  extractorVersion: "xlsx-read-excel-file-v1",
  mimeTypes: XLSX_MIME,
  extensions: ["xlsx", "xlsm"],
  async extract(bytes): Promise<ExtractionResult> {
    let sheets: { name: string; rows: unknown[][] }[];
    try {
      const mod = await import("read-excel-file/node");
      const readXlsx = (mod.default ?? mod) as unknown as (
        input: Buffer,
        options?: { sheet?: number | string; getSheets?: boolean }
      ) => Promise<unknown>;

      // One call returns every sheet with its rows. The library's own shape is
      // `[{sheet, data}]` — verified against a real workbook in
      // tests/unit/knowledge-documents.test.ts, because assuming a flat row
      // array here previously made every workbook fail to parse.
      sheets = toSheets(await readXlsx(bytes, { getSheets: true }));
    } catch (err) {
      return {
        status: "failed",
        text: "",
        structured: null,
        spans: [],
        error: `Spreadsheet extraction failed: ${(err as Error).message}`,
      };
    }

    const spans: ExtractionSpan[] = [];
    let text = "";
    const structured: Record<string, unknown[]> = {};

    for (const sheet of sheets) {
      const [header, ...body] = sheet.rows;
      const headers = (header ?? []).map((cell) => cellText(cell));
      const records: Record<string, string>[] = [];

      if (headers.some((h) => h.length > 0)) {
        text = appendSpan(
          spans,
          text,
          headers.join(" | "),
          `sheet:${sheet.name}!header`,
          sheet.name
        );
      }
      body.forEach((row, index) => {
        const cells = row.map((cell) => cellText(cell));
        if (cells.every((c) => c.length === 0)) return;
        text = appendSpan(
          spans,
          text,
          cells.join(" | "),
          `sheet:${sheet.name}!row:${index + 2}`,
          sheet.name
        );
        const record: Record<string, string> = {};
        headers.forEach((h, col) => {
          if (h.length > 0) record[h] = cells[col] ?? "";
        });
        if (Object.keys(record).length > 0) records.push(record);
      });
      structured[sheet.name] = records;
    }

    const trimmed = text.trim();
    return {
      status: trimmed.length === 0 ? "empty" : "extracted",
      text: trimmed,
      structured,
      spans,
    };
  },
};

/**
 * Normalise whatever the reader returned into `{name, rows}`.
 *
 * Tolerant on purpose: the library's shape is `[{sheet, data}]`, but a bare
 * array of rows is the other plausible contract and costs nothing to accept.
 * A shape matching neither yields no sheets, which surfaces as `empty` rather
 * than as a crash mid-ingest.
 */
function toSheets(result: unknown): { name: string; rows: unknown[][] }[] {
  if (!Array.isArray(result)) return [];

  const wrapped = result.filter(
    (entry): entry is { sheet?: unknown; name?: unknown; data?: unknown } =>
      typeof entry === "object" && entry !== null && !Array.isArray(entry)
  );
  if (wrapped.length > 0) {
    return wrapped.map((entry, index) => ({
      name: String(entry.sheet ?? entry.name ?? `Sheet${index + 1}`),
      rows: Array.isArray(entry.data) ? (entry.data as unknown[][]) : [],
    }));
  }

  // A flat array of rows: one unnamed sheet.
  if (result.every((row) => Array.isArray(row))) {
    return [{ name: "Sheet1", rows: result as unknown[][] }];
  }
  return [];
}

function cellText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  return String(cell).trim();
}
