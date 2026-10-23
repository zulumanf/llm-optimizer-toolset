import { describe, expect, it } from "vitest";
import { ollamaRequestHeaders } from "@/lib/ai/internal/ollama";

describe("hosted inference configuration (release 151)", () => {
  it("local Ollama needs no key", () => {
    expect(ollamaRequestHeaders("http://127.0.0.1:11434", {})).toEqual({ "content-type": "application/json" });
  });
  it("a remote host must be https and authenticated", () => {
    expect(() => ollamaRequestHeaders("http://gpu.example.com:11434", { OLLAMA_API_KEY: "k" })).toThrow(/https/);
    expect(() => ollamaRequestHeaders("https://gpu.example.com", {})).toThrow(/OLLAMA_API_KEY/);
    expect(ollamaRequestHeaders("https://gpu.example.com", { OLLAMA_API_KEY: "k" })).toEqual({
      "content-type": "application/json",
      authorization: "Bearer k",
    });
  });
});
