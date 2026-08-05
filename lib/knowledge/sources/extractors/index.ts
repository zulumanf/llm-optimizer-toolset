/**
 * Extractor registry — capability resolution by mime type, then extension.
 *
 * Mirrors `lib/connectors/registry.ts` deliberately, so this codebase has one
 * registry idiom rather than three.
 *
 * Resolution never throws. An unrecognised type resolves to the `unsupported`
 * extractor, which stores the artifact and says so. Losing a source because we
 * cannot parse it would be the opposite of "raw data is sacred".
 */
import { EXTRACTION_TIMEOUT_MS } from "@/lib/knowledge/constants";
import { pdfExtractor, xlsxExtractor } from "@/lib/knowledge/sources/extractors/documents";
import {
  csvExtractor,
  htmlExtractor,
  jsonExtractor,
  markdownExtractor,
  textExtractor,
} from "@/lib/knowledge/sources/extractors/text";
import type { ExtractionResult, Extractor } from "@/lib/knowledge/sources/extractors/types";

/** Terminal extractor for anything with no text layer we can reach. */
export const unsupportedExtractor: Extractor = {
  key: "unsupported",
  extractorVersion: "unsupported-v1",
  mimeTypes: [],
  extensions: [],
  async extract(): Promise<ExtractionResult> {
    return {
      status: "unsupported",
      text: "",
      structured: null,
      spans: [],
      error:
        "No text extractor exists for this format. The original is stored and hashed; nothing was parsed.",
    };
  },
};

const EXTRACTORS: Extractor[] = [
  textExtractor,
  markdownExtractor,
  htmlExtractor,
  csvExtractor,
  jsonExtractor,
  pdfExtractor,
  xlsxExtractor,
];

export function getExtractor(key: string): Extractor | undefined {
  return key === unsupportedExtractor.key
    ? unsupportedExtractor
    : EXTRACTORS.find((e) => e.key === key);
}

/**
 * Resolve by mime type first — it is what the byte sniffer determined — then
 * by filename extension, which is a hint, not a fact.
 */
export function resolveExtractor(args: {
  mimeType: string;
  filename?: string | null;
}): Extractor {
  const mime = args.mimeType.toLowerCase().split(";")[0]!.trim();
  const byMime = EXTRACTORS.find((e) => e.mimeTypes.includes(mime));
  if (byMime) return byMime;

  const ext = args.filename?.toLowerCase().split(".").pop() ?? "";
  const byExt = ext.length > 0 ? EXTRACTORS.find((e) => e.extensions.includes(ext)) : undefined;
  if (byExt) return byExt;

  // A generic binary/octet-stream upload with a known extension is common;
  // anything still unmatched but textual falls back to plain text rather than
  // being discarded.
  if (mime.startsWith("text/")) return textExtractor;
  return unsupportedExtractor;
}

/**
 * Run an extractor under a wall-clock bound. A parser that hangs on a
 * malformed file must not hold a worker forever — the timeout is the reason
 * `extraction_runs` records duration and attempt.
 */
export async function runExtractor(
  extractor: Extractor,
  bytes: Buffer,
  timeoutMs = EXTRACTION_TIMEOUT_MS
): Promise<{ result: ExtractionResult; durationMs: number }> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const result = await Promise.race([
      extractor.extract(bytes),
      new Promise<ExtractionResult>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Extraction exceeded ${timeoutMs}ms using ${extractor.key}.`)
            ),
          timeoutMs
        );
      }),
    ]);
    return { result, durationMs: Date.now() - started };
  } catch (err) {
    return {
      result: {
        status: "failed",
        text: "",
        structured: null,
        spans: [],
        error: (err as Error).message,
      },
      durationMs: Date.now() - started,
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type { ExtractionResult, ExtractionSpan, Extractor } from "@/lib/knowledge/sources/extractors/types";
