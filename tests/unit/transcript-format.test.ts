/**
 * The transcript parser turns the assistants' markdown subset into a typed
 * AST — presentation only, words untouched. The security property matters
 * most: answers are untrusted text on a public page, and only http/https
 * URLs may become links.
 */
import { describe, expect, it } from "vitest";
import { parseInline, parseTranscript } from "@/lib/prospects/transcript-format";

describe("parseInline", () => {
  it("renders bold and links, words untouched", () => {
    const nodes = parseInline(
      "the **best track record** per ([realtrends.com](https://www.realtrends.com/x?utm_source=openai))"
    );
    expect(nodes).toEqual([
      { kind: "text", text: "the " },
      { kind: "bold", children: [{ kind: "text", text: "best track record" }] },
      { kind: "text", text: " per (" },
      {
        kind: "link",
        href: "https://www.realtrends.com/x?utm_source=openai",
        children: [{ kind: "text", text: "realtrends.com" }],
      },
      { kind: "text", text: ")" },
    ]);
  });

  it("NEVER turns a non-http scheme into a link", () => {
    for (const bad of [
      "[click](javascript:alert(1))",
      "[click](data:text/html;base64,x)",
      "[click](vbscript:x)",
      "[click](file:///etc/passwd)",
    ]) {
      const nodes = parseInline(bad);
      expect(nodes.every((n) => n.kind !== "link"), bad).toBe(true);
    }
  });

  it("leaves unpaired markers as literal text", () => {
    const nodes = parseInline("a ** stray and [half a link](");
    expect(nodes).toEqual([{ kind: "text", text: "a ** stray and [half a link](" }]);
  });
});

describe("parseTranscript", () => {
  it("parses the real answer shape: headings, numbered lists, caveat bullets", () => {
    const blocks = parseTranscript(
      [
        "If by **“best track record”** you mean volume, these lead:",
        "",
        "1. **Properties By Southern (SERHANT.)** — the clearest leader.",
        "2. **Arrived Team (Compass)** — strong performer.",
        "",
        "A few important caveats:",
        "- The data is **not all from the same year**.",
        "- “Best” can also mean condo expertise.",
        "",
        "**Bottom line:**  ",
        "For pure production, Properties By Southern leads.",
      ].join("\n")
    );
    expect(blocks.map((b) => b.kind)).toEqual([
      "paragraph",
      "ordered-list",
      "paragraph",
      "bullet-list",
      "paragraph",
    ]);
    const list = blocks[1];
    if (list?.kind !== "ordered-list") throw new Error("expected ordered list");
    expect(list.items).toHaveLength(2);
  });

  it("merges blank-line-separated items into ONE list (assistants number every item '1.')", () => {
    const blocks = parseTranscript(
      "Intro:\n\n1. **First team** — leader.\n\n1. **Second team** — runner-up.\n\n1. **Third team** — notable.\n\nA few caveats:"
    );
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "ordered-list", "paragraph"]);
    const list = blocks[1];
    if (list?.kind !== "ordered-list") throw new Error("expected ordered list");
    // One <ol> of three — the browser renumbers 1, 2, 3, as the
    // assistant's own app would have.
    expect(list.items).toHaveLength(3);
  });

  it("keeps wrapped list-item lines attached to their item", () => {
    const blocks = parseTranscript("1. First line\n   continues here\n2. Second");
    if (blocks[0]?.kind !== "ordered-list") throw new Error("expected list");
    expect(blocks[0].items).toHaveLength(2);
    const joined = blocks[0].items[0]!.map((n) =>
      n.kind === "text" ? n.text : ""
    ).join("");
    expect(joined).toContain("continues here");
  });
});
