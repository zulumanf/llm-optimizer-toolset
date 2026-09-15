/**
 * Deterministic on-page verification of a discovered contact email: the
 * literal address must appear on a fetched public page (plain text or a
 * Cloudflare-obfuscated mailto). Discovery (Perplexity, a web agent, a
 * human) proposes; this check is what makes a contact `publicly_sourced`.
 * Extracted from scripts/cohort124-gap-enrich.ts (2026-08-31) so every
 * sourcing pass verifies the same way.
 */
import { execFileSync } from "node:child_process";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** Decode every `data-cfemail` attribute on a page (first byte is the XOR key). */
export function decodeCloudflareEmails(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/data-cfemail="([0-9a-f]+)"/gi)) {
    const hex = m[1]!;
    const bytes: number[] = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    const key = bytes[0]!;
    out.push(bytes.slice(1).map((b) => String.fromCharCode(b ^ key)).join(""));
  }
  return out;
}

/** Pure: does the fetched HTML state the email literally (or cf-encoded)? */
export function htmlStatesEmail(html: string, email: string): boolean {
  const target = email.toLowerCase();
  if (html.toLowerCase().includes(target)) return true;
  return decodeCloudflareEmails(html).some((e) => e.toLowerCase() === target);
}

/** Fetch a page and report whether the literal email appears on it. */
export function emailOnPage(url: string, email: string): boolean {
  let html = "";
  try {
    html = execFileSync("curl", ["-sL", "--max-time", "20", "-A", UA, url], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return false;
  }
  return htmlStatesEmail(html, email);
}

/** Rendered-page verification (supply engine 2026-09-14): the same literal
 * rule applied to the DOM a public page produces after its scripts run.
 * Used only after a plain fetch returned a JS shell; the source type is
 * recorded as `rendered_page` so provenance stays honest. */
export async function emailOnRenderedPage(url: string, email: string): Promise<boolean> {
  try {
    const { renderPageHtml } = await import("@/lib/prospects/contact-render");
    const { html } = await renderPageHtml(url);
    return htmlStatesEmail(html, email);
  } catch {
    return false;
  }
}
