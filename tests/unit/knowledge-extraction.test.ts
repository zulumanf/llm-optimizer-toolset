/**
 * Spec 021 — extractors, mime sniffing, normalization and token counting.
 * Pure functions only; the database path is covered by the integration suite.
 */
import { describe, expect, it } from "vitest";
import {
  csvExtractor,
  htmlExtractor,
  jsonExtractor,
  looksLikeHeader,
  markdownExtractor,
  parseCsv,
  textExtractor,
} from "@/lib/knowledge/sources/extractors/text";
import {
  resolveExtractor,
  runExtractor,
  unsupportedExtractor,
} from "@/lib/knowledge/sources/extractors";
import { looksTextual, sniffMimeType, sourceTypeForMime } from "@/lib/knowledge/sources/mime";
import {
  bestMatch,
  normalizeAmount,
  normalizeDate,
  normalizeDomain,
  normalizeEntityName,
  normalizeUrl,
  scoreNameMatch,
  slugify,
} from "@/lib/knowledge/normalize";
import { estimateTokens, truncateToTokens } from "@/lib/knowledge/context/tokens";
import { isPrivateHost } from "@/lib/knowledge/sources/ingest";
import { sourceStorageKey } from "@/lib/knowledge/sources/storage";
import { resolveStoragePath, sha256Of } from "@/lib/storage/content-addressed";

const buf = (s: string) => Buffer.from(s, "utf8");

describe("csv parsing (RFC 4180)", () => {
  it("handles quoted fields, escaped quotes and embedded separators", () => {
    const rows = parseCsv('name,notes\n"Doe, Jane","She said ""hi"""\nBob,plain');
    expect(rows).toEqual([
      ["name", "notes"],
      ["Doe, Jane", 'She said "hi"'],
      ["Bob", "plain"],
    ]);
  });

  it("accepts CRLF and skips blank rows", () => {
    expect(parseCsv("a,b\r\n1,2\r\n\r\n3,4")).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("detects a header only when every cell is non-numeric text", () => {
    expect(looksLikeHeader(["name", "city"])).toBe(true);
    expect(looksLikeHeader(["name", "2024"])).toBe(false);
    expect(looksLikeHeader(["name", ""])).toBe(false);
    expect(looksLikeHeader([])).toBe(false);
  });

  it("produces one span per row so an excerpt can cite its location", async () => {
    const result = await csvExtractor.extract(
      buf("address,price\n12 Grove St,1200000\n8 Erie St,880000")
    );
    expect(result.status).toBe("extracted");
    expect(result.spans.map((s) => s.locator)).toEqual(["header", "row 1", "row 2"]);
    // Each span must actually address the text it claims to.
    const row1 = result.spans.find((s) => s.locator === "row 1")!;
    expect(result.text.slice(row1.start, row1.end)).toContain("12 Grove St");
    expect((result.structured as { rows: Record<string, string>[] }).rows[0]).toEqual({
      address: "12 Grove St",
      price: "1200000",
    });
  });
});

describe("html extraction", () => {
  it("drops script and style content, keeps title and meta", async () => {
    const result = await htmlExtractor.extract(
      buf(
        `<html><head><title>JC Luxury</title>
         <meta name="description" content="Jersey City waterfront">
         <style>.a{color:red}</style><script>var secret=1;</script></head>
         <body><h1>Waterfront</h1><p>We closed 40 homes.</p></body></html>`
      )
    );
    expect(result.text).toContain("Waterfront");
    expect(result.text).toContain("We closed 40 homes.");
    expect(result.text).not.toContain("secret");
    expect(result.text).not.toContain("color:red");
    const structured = result.structured as { title: string; meta: Record<string, string> };
    expect(structured.title).toBe("JC Luxury");
    expect(structured.meta.description).toBe("Jersey City waterfront");
  });

  it("decodes named and numeric entities", async () => {
    const result = await htmlExtractor.extract(buf("<p>Smith &amp; Co &#8212; &quot;top&quot;</p>"));
    expect(result.text).toBe('Smith & Co — "top"');
  });
});

describe("markdown and text extraction", () => {
  it("anchors markdown spans to headings", async () => {
    const result = await markdownExtractor.extract(
      buf("# Overview\nWe serve JC.\n\n## Markets\nJersey City, Hoboken.")
    );
    // A document opening on a heading has no preamble, so none is emitted.
    expect(result.spans.map((s) => s.locator)).toEqual(["Overview", "Markets"]);
    const markets = result.spans.find((s) => s.locator === "Markets")!;
    expect(result.text.slice(markets.start, markets.end)).toContain("Hoboken");
  });

  it("captures text before the first heading as a preamble span", async () => {
    const result = await markdownExtractor.extract(buf("Intro line.\n\n# Overview\nBody."));
    expect(result.spans.map((s) => s.locator)).toEqual(["(preamble)", "Overview"]);
    const preamble = result.spans[0]!;
    expect(result.text.slice(preamble.start, preamble.end)).toContain("Intro line.");
  });

  it("reports an empty source as empty rather than extracted", async () => {
    expect((await textExtractor.extract(buf("   \n  "))).status).toBe("empty");
  });
});

describe("json extraction", () => {
  it("flattens to path/value lines with path locators", async () => {
    const result = await jsonExtractor.extract(buf('{"agent":{"name":"Ana","sales":[1,2]}}'));
    expect(result.text).toContain("$.agent.name: Ana");
    expect(result.spans.map((s) => s.locator)).toContain("$.agent.sales[1]");
  });

  it("falls back to NDJSON before failing", async () => {
    const result = await jsonExtractor.extract(buf('{"a":1}\n{"a":2}'));
    expect(result.status).toBe("extracted");
    expect((result.structured as unknown[]).length).toBe(2);
  });

  it("reports invalid JSON as failed, not empty", async () => {
    const result = await jsonExtractor.extract(buf("{nope"));
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Not valid JSON");
  });
});

describe("extractor resolution", () => {
  it("prefers mime type, then extension, then textual fallback", () => {
    expect(resolveExtractor({ mimeType: "text/csv" }).key).toBe("csv");
    expect(resolveExtractor({ mimeType: "application/octet-stream", filename: "a.md" }).key).toBe(
      "markdown"
    );
    expect(resolveExtractor({ mimeType: "text/x-unknown" }).key).toBe("text");
  });

  it("resolves an unknown binary to unsupported rather than throwing", () => {
    const extractor = resolveExtractor({ mimeType: "video/mp4", filename: "tour.mp4" });
    expect(extractor.key).toBe(unsupportedExtractor.key);
  });

  it("stores the artifact and says so when nothing can be parsed", async () => {
    const result = await unsupportedExtractor.extract(buf("anything"));
    expect(result.status).toBe("unsupported");
    expect(result.error).toContain("No text extractor");
  });

  it("bounds a hanging extractor instead of holding the worker", async () => {
    const hanging = {
      key: "hang",
      extractorVersion: "hang-v1",
      mimeTypes: [],
      extensions: [],
      extract: () => new Promise<never>(() => {}),
    };
    const { result } = await runExtractor(hanging, buf("x"), 20);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("exceeded 20ms");
  });
});

describe("mime sniffing (bytes decide, not the uploader)", () => {
  it("identifies formats by magic number over a false declared type", () => {
    expect(sniffMimeType({ bytes: buf("%PDF-1.7 ..."), declared: "text/plain" })).toBe(
      "application/pdf"
    );
    expect(
      sniffMimeType({ bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), declared: "text/csv" })
    ).toBe("image/png");
  });

  it("only calls a zip a workbook when the name or declared type says so", () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00]);
    expect(sniffMimeType({ bytes: zip, filename: "q3.xlsx" })).toContain("spreadsheetml");
    expect(sniffMimeType({ bytes: zip, filename: "photos.zip" })).toBe("application/zip");
  });

  it("distinguishes textual dialects by shape when there is no extension", () => {
    expect(sniffMimeType({ bytes: buf("<!doctype html><html>") })).toBe("text/html");
    expect(sniffMimeType({ bytes: buf('{"a":1}') })).toBe("application/json");
    expect(sniffMimeType({ bytes: buf("# Heading\n\ntext") })).toBe("text/markdown");
  });

  it("treats NUL-bearing content as binary", () => {
    expect(looksTextual(Buffer.from([0x41, 0x00, 0x42]))).toBe(false);
    expect(looksTextual(buf("plain text\n"))).toBe(true);
  });

  it("maps mime types to source types", () => {
    expect(sourceTypeForMime("application/pdf")).toBe("pdf");
    expect(sourceTypeForMime("text/html")).toBe("website");
    expect(sourceTypeForMime("image/png")).toBe("image");
  });
});

describe("normalization preserves the original and the ambiguity", () => {
  it("normalizes urls without losing meaningful query state", () => {
    expect(normalizeUrl("HTTPS://WWW.Example.com/Path/?utm_source=x&b=2&a=1#frag")).toBe(
      "https://example.com/Path?a=1&b=2"
    );
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
    // A trailing slash is not a different resource, with or without a query.
    expect(normalizeUrl("https://example.com/about/")).toBe("https://example.com/about");
    // Unparseable input is returned untouched rather than mangled.
    expect(normalizeUrl("not a url")).toBe("not a url");
  });

  it("normalizes domains from bare hosts and full urls alike", () => {
    expect(normalizeDomain("https://www.JCLuxury.com/about")).toBe("jcluxury.com");
    expect(normalizeDomain("WWW.JCLuxury.com")).toBe("jcluxury.com");
  });

  it("parses the date shapes that appear in real exports", () => {
    expect(normalizeDate("2025-03-04")).toBe("2025-03-04");
    expect(normalizeDate("3/4/2025")).toBe("2025-03-04");
    expect(normalizeDate("March 4, 2025")).toBe("2025-03-04");
    expect(normalizeDate("4 Mar 2025")).toBe("2025-03-04");
    expect(normalizeDate("Q3 2025")).toBe("2025-07-01");
    expect(normalizeDate("2025")).toBe("2025-01-01");
  });

  it("returns null for an unparseable date rather than guessing", () => {
    expect(normalizeDate("sometime last spring")).toBeNull();
    expect(normalizeDate("")).toBeNull();
  });

  it("holds money in minor units so no float carries a price", () => {
    expect(normalizeAmount("$1.2M")).toEqual({
      minorUnits: 120_000_000,
      currency: "USD",
      originalValue: "$1.2M",
    });
    expect(normalizeAmount("180,000")!.minorUnits).toBe(18_000_000);
    expect(normalizeAmount("£450k")!.currency).toBe("GBP");
    expect(normalizeAmount("not a number")).toBeNull();
  });

  it("casefolds entity names and drops corporate noise", () => {
    expect(normalizeEntityName("The JC Luxury Group, LLC")).toBe("jc luxury");
    expect(normalizeEntityName("J.C. Luxury")).toBe("jc luxury");
    expect(slugify("JC Luxury Group")).toBe("jc-luxury-group");
  });

  it("bands match confidence and flags everything below exact for review", () => {
    expect(scoreNameMatch("JC Luxury Group LLC", "JC Luxury Group")).toMatchObject({
      matchStatus: "exact",
      requiresReview: false,
    });
    expect(scoreNameMatch("JC Luxury", "JC Luxury Waterfront Team")).toMatchObject({
      matchStatus: "probable",
      requiresReview: true,
    });
    expect(scoreNameMatch("Hudson Realty Partners", "Hudson Realty Advisors")).toMatchObject({
      matchStatus: "ambiguous",
      requiresReview: true,
    });
    expect(scoreNameMatch("Acme Widgets", "JC Luxury").matchStatus).toBe("unmatched");
  });

  it("refuses to pick a winner when two candidates tie", () => {
    const tie = bestMatch("Hudson Group", [
      { id: "a", name: "Hudson Realty" },
      { id: "b", name: "Hudson Advisors" },
    ]);
    expect(tie.entityId).toBeNull();
    expect(tie.match.matchStatus).toBe("ambiguous");
    expect(tie.match.requiresReview).toBe(true);
  });

  it("returns the single best match when there is no tie", () => {
    const picked = bestMatch("JC Luxury Group", [
      { id: "a", name: "JC Luxury Group" },
      { id: "b", name: "Acme Realty" },
    ]);
    expect(picked.entityId).toBe("a");
    expect(picked.match.matchStatus).toBe("exact");
  });
});

describe("token estimation", () => {
  it("is monotonic in length, so a budget check cannot be gamed", () => {
    const short = estimateTokens("a short line");
    const long = estimateTokens("a short line with considerably more words appended to it");
    expect(long).toBeGreaterThan(short);
    expect(estimateTokens("")).toBe(0);
  });

  it("lands within a sane band of the 4-chars-per-token rule", () => {
    const text = "The client operates in Jersey City and Hoboken. ".repeat(20);
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThan(text.length / 8);
    expect(tokens).toBeLessThan(text.length / 2);
  });

  it("truncates on a word boundary and reports what was dropped", () => {
    const text = "alpha beta gamma delta epsilon zeta eta theta iota kappa";
    const cut = truncateToTokens(text, 5);
    expect(cut.truncated).toBe(true);
    expect(cut.droppedTokens).toBeGreaterThan(0);
    expect(cut.text.endsWith(" ")).toBe(false);
    // No half-words: every retained token is a whole word from the source.
    for (const word of cut.text.split(" ")) {
      expect(text.split(" ")).toContain(word);
    }
  });

  it("leaves text under budget untouched", () => {
    expect(truncateToTokens("short", 100)).toEqual({
      text: "short",
      truncated: false,
      droppedTokens: 0,
    });
  });
});

describe("storage safety", () => {
  it("refuses a storage key that escapes its root", () => {
    expect(() => resolveStoragePath("/var/knowledge", "../../etc/passwd")).toThrow(/Invalid/);
    expect(() => resolveStoragePath("/var/knowledge", "")).toThrow(/empty/);
    // A sibling directory sharing a prefix must not pass a bare startsWith test.
    expect(() => resolveStoragePath("/var/knowledge", "../knowledge-other/x")).toThrow(/Invalid/);
  });

  it("derives a deterministic, client-partitioned key from content", () => {
    const sha = sha256Of(buf("hello"));
    const key = sourceStorageKey("proj-1", sha);
    expect(key).toBe(`proj-1/${sha.slice(0, 2)}/${sha}`);
    // Same bytes, different client, different path: deletion cannot cross clients.
    expect(sourceStorageKey("proj-2", sha)).not.toBe(key);
  });
});

describe("url fetch guards", () => {
  it("rejects loopback, link-local and private ranges", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "0.0.0.0",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "169.254.169.254",
      "::1",
      "fd00::1",
      "svc.internal",
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it("allows ordinary public hosts", () => {
    for (const host of ["example.com", "8.8.8.8", "172.32.0.1", "11.0.0.1"]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});
