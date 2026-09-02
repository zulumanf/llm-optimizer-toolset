/**
 * Pins prompt v4 (spec 114): the system prompt renders the compact tool
 * catalog, the current pathname, today's date, and the operator's standing
 * preferences — and the version constant the chat service hands to
 * runAgent (it imports this exact constant) stays what docs/13 registers.
 */
import { describe, expect, it } from "vitest";
import {
  ASSISTANT_PROMPT_VERSION,
  ASSISTANT_TASK_PROMPT_VERSION,
  assistantSystemPrompt,
  assistantTaskPrompt,
} from "@/lib/assistant/prompt";
import { compactCatalog } from "@/lib/assistant/tools";

const BASE = {
  userName: "Fran",
  today: "2026-08-24",
  pathname: "/prospects/abc",
  toolCatalog: compactCatalog(),
};

describe("assistantSystemPrompt (v4)", () => {
  it("is registered as workspace-assistant-v4 — the constant the service passes to runAgent", () => {
    expect(ASSISTANT_PROMPT_VERSION).toBe("workspace-assistant-v4");
    expect(ASSISTANT_TASK_PROMPT_VERSION).toBe("assistant-task-v1");
  });

  it("renders the catalog, pathname, user name, and today's date", () => {
    const prompt = assistantSystemPrompt({ ...BASE, preferences: null });
    // The whole compact catalog is embedded verbatim.
    expect(prompt).toContain(BASE.toolCatalog);
    expect(prompt).toContain("AVAILABLE TOOLS (compact catalog");
    expect(prompt).toContain("currently on the page: /prospects/abc");
    expect(prompt).toContain("Today is 2026-08-24");
    expect(prompt).toContain("talking to Fran (staff)");
  });

  it("renders the preferences block only when preferences exist, with the rules-win framing", () => {
    const without = assistantSystemPrompt({ ...BASE, preferences: null });
    expect(without).not.toContain("OPERATOR STANDING PREFERENCES");

    const withPrefs = assistantSystemPrompt({
      ...BASE,
      preferences: "Default run budget is $7.",
    });
    expect(withPrefs).toContain("OPERATOR STANDING PREFERENCES (from Fran");
    expect(withPrefs).toContain("Default run budget is $7.");
    expect(withPrefs).toContain("confirmation gates above always win");
  });

  it("the task prompt renders the goal, catalog, date, and preferences the same way", () => {
    const prompt = assistantTaskPrompt({
      userName: "Fran",
      today: "2026-08-24",
      goal: "Report Task Co's stage.",
      toolCatalog: BASE.toolCatalog,
      preferences: "Never exceed $5 per run.",
    });
    expect(prompt).toContain("GOAL: Report Task Co's stage.");
    expect(prompt).toContain(BASE.toolCatalog);
    expect(prompt).toContain("Today is 2026-08-24");
    expect(prompt).toContain("OPERATOR STANDING PREFERENCES (from Fran");
    expect(prompt).toContain("Never exceed $5 per run.");
  });
});
