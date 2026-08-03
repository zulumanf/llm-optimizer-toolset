/**
 * The exhibit allowlist (spec 045): only share links on the assistant
 * vendors' own domains may ever render on a prospect-facing page.
 */
import { describe, expect, it } from "vitest";
import { exhibitAssistantFor } from "@/lib/prospects/exhibits";

describe("exhibitAssistantFor", () => {
  it("accepts ChatGPT and Perplexity share URLs, mapping the assistant", () => {
    expect(
      exhibitAssistantFor("https://chatgpt.com/share/6a70b24b-3870-83ea-bf59-8bad25a8e0d2")
    ).toBe("chatgpt");
    expect(exhibitAssistantFor("https://chat.openai.com/share/abc")).toBe("chatgpt");
    expect(exhibitAssistantFor("https://www.perplexity.ai/search/some-thread")).toBe(
      "perplexity"
    );
    expect(exhibitAssistantFor("https://perplexity.ai/search/some-thread")).toBe(
      "perplexity"
    );
  });

  it("rejects everything else — lookalikes, http, other hosts, non-share paths", () => {
    for (const url of [
      "https://chatgpt.com.evil.example/share/x", // lookalike host
      "https://evil.example/https://chatgpt.com/share/x",
      "http://chatgpt.com/share/x", // not https
      "https://chatgpt.com/c/private-conversation", // not a share path
      "https://openai.com/share/x",
      "https://example.com/",
    ]) {
      expect(exhibitAssistantFor(url)).toBeNull();
    }
  });
});
