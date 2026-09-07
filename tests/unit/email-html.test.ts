/**
 * Unit tests for spec 092's HTML rendering: the HTML part must be a
 * mechanical rendering of the approved plain text (escaped, line breaks)
 * plus at most the tracking pixel — never content of its own.
 */
import { describe, expect, it } from "vitest";
import { escapeHtml, plainTextToTrackedHtml } from "@/lib/text/html";

describe("escapeHtml", () => {
  it("escapes markup-significant characters", () => {
    expect(escapeHtml(`<b>&"a"</b>`)).toBe(`&lt;b&gt;&amp;&quot;a&quot;&lt;/b&gt;`);
  });
});

describe("plainTextToTrackedHtml", () => {
  it("escapes the body, renders line breaks, and appends the pixel", () => {
    const html = plainTextToTrackedHtml(
      "Hi <there>,\nline two & three",
      "https://app.test.local/api/open/abc123"
    );
    expect(html).toContain("Hi &lt;there&gt;,<br>");
    expect(html).toContain("line two &amp; three");
    expect(html).toContain(
      `<img src="https://app.test.local/api/open/abc123" width="1" height="1"`
    );
  });

  it("renders no pixel when the URL is null (untracked send)", () => {
    const html = plainTextToTrackedHtml("Hello", null);
    expect(html).toContain("Hello");
    expect(html).not.toContain("<img");
  });

  it("cannot smuggle markup through the pixel URL", () => {
    const html = plainTextToTrackedHtml("Hello", `https://x/"><script>`);
    expect(html).not.toContain("<script>");
  });
});
