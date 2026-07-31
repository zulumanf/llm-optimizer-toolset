/**
 * Mime sniffing from bytes.
 *
 * The client-declared content type is a claim by the uploader, and this layer
 * does not trust uploader claims about anything else either. Magic numbers
 * decide; the declared type is only a tie-breaker for formats that share a
 * textual prefix (CSV vs plain text, Markdown vs plain text).
 */

const MAGIC: { bytes: number[]; mime: string }[] = [
  { bytes: [0x25, 0x50, 0x44, 0x46], mime: "application/pdf" }, // %PDF
  { bytes: [0x89, 0x50, 0x4e, 0x47], mime: "image/png" },
  { bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif" },
  { bytes: [0x25, 0x21, 0x50, 0x53], mime: "application/postscript" },
];

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];
const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const EXTENSION_MIME: Record<string, string> = {
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  html: "text/html",
  htm: "text/html",
  csv: "text/csv",
  tsv: "text/csv",
  json: "application/json",
  jsonl: "application/json",
  ndjson: "application/json",
  pdf: "application/pdf",
  xlsx: XLSX_MIME,
  xlsm: XLSX_MIME,
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function startsWith(bytes: Buffer, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

/** True when the buffer is plausibly UTF-8 text (no NULs in the first 8 KiB). */
export function looksTextual(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, 8192);
  for (const byte of sample) {
    // NUL, or a C0 control that is not tab/LF/CR/FF, means binary.
    if (byte === 0) return false;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
  }
  return true;
}

/**
 * Decide the mime type. `declared` and `filename` are hints used only where the
 * bytes are genuinely ambiguous — every text format shares the same prefix.
 */
export function sniffMimeType(args: {
  bytes: Buffer;
  declared?: string | null;
  filename?: string | null;
}): string {
  const { bytes } = args;

  for (const entry of MAGIC) {
    if (startsWith(bytes, entry.bytes)) return entry.mime;
  }

  // An OOXML workbook is a zip. Only the extension or the declared type
  // distinguishes it from any other zip, so require one of them to say so.
  if (startsWith(bytes, ZIP_MAGIC)) {
    const ext = extensionOf(args.filename);
    if (ext === "xlsx" || ext === "xlsm") return XLSX_MIME;
    if (args.declared && args.declared.includes("spreadsheetml")) return XLSX_MIME;
    return "application/zip";
  }

  if (!looksTextual(bytes)) return "application/octet-stream";

  // Textual: let the extension pick the dialect, then fall back to shape.
  const ext = extensionOf(args.filename);
  if (ext && EXTENSION_MIME[ext]) return EXTENSION_MIME[ext]!;

  const head = bytes.subarray(0, 4096).toString("utf8").trimStart();
  if (/^<(!doctype html|html|head|body)/i.test(head)) return "text/html";
  if (head.startsWith("{") || head.startsWith("[")) return "application/json";
  if (/^#{1,6}\s/m.test(head) || /^\s*[-*]\s+/m.test(head)) return "text/markdown";

  const declared = args.declared?.toLowerCase().split(";")[0]?.trim();
  if (declared && declared.startsWith("text/")) return declared;
  return "text/plain";
}

function extensionOf(filename?: string | null): string | null {
  if (!filename) return null;
  const parts = filename.toLowerCase().split(".");
  return parts.length > 1 ? parts.pop()! : null;
}

/** Source type implied by a mime type, used when the caller does not declare one. */
export function sourceTypeForMime(mime: string): string {
  if (mime === "application/pdf") return "pdf";
  if (mime === XLSX_MIME) return "spreadsheet";
  if (mime === "text/html") return "website";
  if (mime === "text/csv") return "crm_export";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("text/") || mime === "application/json") return "document";
  return "other";
}
