import { describe, expect, it } from "vitest";
import { extractCitations } from "@/lib/ai/citations";

describe("extractCitations", () => {
  it("extracts OpenAI Responses url_citation annotations and strips tracking", () => {
    const payload = {
      output: [
        { type: "web_search_call" },
        {
          type: "message",
          content: [
            {
              type: "output_text",
              text: "answer",
              annotations: [
                {
                  type: "url_citation",
                  url: "https://simplelistings.co/en/blog/best?utm_source=openai",
                  title: "10 best link in bio tools",
                  start_index: 1,
                  end_index: 2,
                },
                {
                  type: "url_citation",
                  url: "https://agentbio.co/?utm_source=openai",
                  title: "AgentBio",
                },
              ],
            },
          ],
        },
      ],
    };
    const citations = extractCitations("openai", payload);
    expect(citations).toHaveLength(2);
    expect(citations[0]?.url).toBe("https://simplelistings.co/en/blog/best");
    expect(citations[0]?.domain).toBe("simplelistings.co");
    expect(citations[1]?.url).toBe("https://agentbio.co/");
    expect(citations[1]?.title).toBe("AgentBio");
  });

  it("extracts OpenAI chat-completions annotations (search-api models)", () => {
    const payload = {
      choices: [
        {
          message: {
            annotations: [
              {
                type: "url_citation",
                url_citation: { url: "https://example.com/a", title: "A" },
              },
            ],
          },
        },
      ],
    };
    expect(extractCitations("openai", payload)).toEqual([
      { url: "https://example.com/a", title: "A", domain: "example.com" },
    ]);
  });

  it("extracts Perplexity citations and search_results, deduplicated", () => {
    const payload = {
      citations: ["https://a.com/x", "https://b.com/y"],
      search_results: [
        { url: "https://a.com/x", title: "A" },
        { url: "https://c.com/z", title: "C" },
      ],
    };
    const citations = extractCitations("perplexity", payload);
    expect(citations.map((c) => c.domain)).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("extracts Anthropic web-search citations", () => {
    const payload = {
      content: [
        {
          type: "text",
          citations: [{ url: "https://docs.example.com/p", title: "Doc" }],
        },
      ],
    };
    expect(extractCitations("anthropic", payload)[0]?.domain).toBe(
      "docs.example.com"
    );
  });

  it("extracts Google grounding chunks", () => {
    const payload = {
      candidates: [
        {
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: "https://g.example.com/r", title: "G" } },
            ],
          },
        },
      ],
    };
    expect(extractCitations("google", payload)[0]?.domain).toBe("g.example.com");
  });

  it("returns [] for malformed payloads and unknown providers", () => {
    expect(extractCitations("openai", null)).toEqual([]);
    expect(extractCitations("openai", { output: "not-an-array" })).toEqual([]);
    expect(extractCitations("mock", { anything: true })).toEqual([]);
  });
});
