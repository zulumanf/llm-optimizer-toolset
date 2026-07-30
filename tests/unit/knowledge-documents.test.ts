/**
 * Spec 021 — PDF and XLSX extraction against real generated files.
 *
 * These were the two extractors shipped without tests. Both bring a new
 * dependency into the repo, and both parse untrusted binary input, which makes
 * them the last place unverified parsing should have been left.
 *
 * Fixtures are genuine PDFs and workbooks built by `tests/fixtures/documents.ts`
 * — not mocks. Mocking `unpdf` would only prove the mock returns what it was
 * told to; what matters is whether a real text layer comes out with correct
 * page spans, and whether a scan is reported as having no text rather than as
 * a successful extraction of nothing.
 */
import { describe, expect, it } from "vitest";
import { pdfExtractor, xlsxExtractor } from "@/lib/knowledge/sources/extractors/documents";
import { resolveExtractor } from "@/lib/knowledge/sources/extractors";
import { sniffMimeType } from "@/lib/knowledge/sources/mime";
import { buildPdf, buildScannedPdf, buildXlsx } from "../fixtures/documents";

describe("PDF extraction", () => {
  it("extracts the text layer with one span per page", async () => {
    const bytes = buildPdf([
      "Northvale Demo Group operates in Jersey City.",
      "The team closed 40 transactions in 2025.",
    ]);
    const result = await pdfExtractor.extract(bytes);

    expect(result.status).toBe("extracted");
    expect(result.text).toContain("Northvale Demo Group operates in Jersey City.");
    expect(result.text).toContain("closed 40 transactions");
    expect(result.spans.map((s) => s.locator)).toEqual(["page 1", "page 2"]);
    expect((result.structured as { pageCount: number }).pageCount).toBe(2);
  });

  it("anchors each span to text actually on that page", async () => {
    // A span that does not address its own page makes every evidence excerpt
    // built from a PDF untrustworthy.
    const bytes = buildPdf(["First page content here.", "Second page content here."]);
    const result = await pdfExtractor.extract(bytes);

    const page2 = result.spans.find((s) => s.locator === "page 2")!;
    const slice = result.text.slice(page2.start, page2.end);
    expect(slice).toContain("Second page");
    expect(slice).not.toContain("First page");
  });

  it("reports a scan as empty and says why, rather than as a successful parse", async () => {
    const result = await pdfExtractor.extract(buildScannedPdf());

    expect(result.status).toBe("empty");
    expect(result.text).toBe("");
    // "0 claims found" and "this file has no text layer" are different
    // problems with different fixes, so the reason is stated.
    expect(result.error).toContain("no extractable text layer");
    expect(result.error).toContain("No OCR");
  });

  it("fails cleanly on bytes that are not a PDF", async () => {
    const result = await pdfExtractor.extract(Buffer.from("this is not a pdf", "utf8"));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("PDF extraction failed");
    // The ingest pipeline keeps the artifact regardless; the parse is what failed.
    expect(result.text).toBe("");
  });

  it("is routed to by a sniffed PDF, not by a claimed content type", () => {
    const bytes = buildPdf(["anything"]);
    expect(sniffMimeType({ bytes, declared: "text/plain", filename: "notes.txt" })).toBe(
      "application/pdf"
    );
    expect(resolveExtractor({ mimeType: "application/pdf" }).key).toBe("pdf");
  });
});

describe("XLSX extraction", () => {
  const workbook = () =>
    buildXlsx([
      {
        name: "Transactions",
        rows: [
          ["address", "price", "closed"],
          ["12 Grove St", 1_200_000, "2025-03-04"],
          ["8 Erie St", 880_000, "2025-06-18"],
        ],
      },
    ]);

  it("extracts rows with sheet-and-row span locators", async () => {
    const result = await xlsxExtractor.extract(workbook());

    expect(result.status).toBe("extracted");
    expect(result.text).toContain("12 Grove St");
    expect(result.text).toContain("880000");
    expect(result.spans.map((s) => s.locator)).toEqual([
      "sheet:Transactions!header",
      "sheet:Transactions!row:2",
      "sheet:Transactions!row:3",
    ]);
  });

  it("keys structured rows by header so a claim can cite a field", async () => {
    const result = await xlsxExtractor.extract(workbook());
    const structured = result.structured as Record<string, Record<string, string>[]>;
    const rows = structured.Transactions ?? [];

    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      address: "12 Grove St",
      price: "1200000",
      closed: "2025-03-04",
    });
  });

  it("anchors a row span to that row's own text", async () => {
    const result = await xlsxExtractor.extract(workbook());
    const row3 = result.spans.find((s) => s.locator === "sheet:Transactions!row:3")!;
    const slice = result.text.slice(row3.start, row3.end);

    expect(slice).toContain("8 Erie St");
    expect(slice).not.toContain("12 Grove St");
  });

  it("reads every sheet, labelling spans per sheet", async () => {
    const result = await xlsxExtractor.extract(
      buildXlsx([
        { name: "Q1", rows: [["market"], ["Jersey City"]] },
        { name: "Q2", rows: [["market"], ["Hoboken"]] },
      ])
    );

    const sheets = new Set(result.spans.map((s) => s.label));
    expect(sheets).toEqual(new Set(["Q1", "Q2"]));
    expect(result.text).toContain("Jersey City");
    expect(result.text).toContain("Hoboken");
  });

  it("reports an empty workbook as empty, not extracted", async () => {
    const result = await xlsxExtractor.extract(buildXlsx([{ name: "Sheet1", rows: [] }]));
    expect(result.status).toBe("empty");
    expect(result.text).toBe("");
  });

  it("fails cleanly on bytes that are not a workbook", async () => {
    const result = await xlsxExtractor.extract(Buffer.from("PK not really a zip", "utf8"));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Spreadsheet extraction failed");
  });

  it("is routed to only when the name or declared type identifies a workbook", () => {
    const bytes = workbook();
    expect(sniffMimeType({ bytes, filename: "transactions.xlsx" })).toContain("spreadsheetml");
    // A bare zip with no such signal must not be parsed as a workbook.
    expect(sniffMimeType({ bytes, filename: "archive.zip" })).toBe("application/zip");
  });
});
