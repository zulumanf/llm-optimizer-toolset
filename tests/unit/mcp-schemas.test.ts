/**
 * Contract tests for the MCP tool input schemas and args hashing (spec 033).
 * Pure — imports no database module, so they run on a machine without
 * Postgres, matching the unit-test convention.
 */
import { describe, expect, it } from "vitest";
import {
  citationSourcesSchema,
  createExperimentSchema,
  gapReportSchema,
  projectIdSchema,
  runPromptSetSchema,
} from "@/lib/mcp/schemas";
import { hashArgs } from "@/lib/mcp/hash";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const VERSION_ID = "22222222-2222-4222-8222-222222222222";

const validRun = {
  project_id: PROJECT_ID,
  prompt_set_version_id: VERSION_ID,
  label: "weekly",
  providers: [{ provider: "mock", model: "mock-model", repetitions: 2 }],
  budget_usd: 5,
};

describe("mcp schemas", () => {
  it("rejects unknown keys instead of stripping them", () => {
    expect(projectIdSchema.safeParse({ project_id: PROJECT_ID, extra: 1 }).success).toBe(
      false
    );
    expect(
      runPromptSetSchema.safeParse({ ...validRun, surprise: true }).success
    ).toBe(false);
  });

  it("rejects malformed uuids", () => {
    expect(projectIdSchema.safeParse({ project_id: "not-a-uuid" }).success).toBe(false);
    expect(gapReportSchema.safeParse({ project_id: PROJECT_ID, run_id: "x" }).success).toBe(
      false
    );
  });

  it("caps get_citation_sources limit at 50 and defaults to 15", () => {
    expect(
      citationSourcesSchema.safeParse({ project_id: PROJECT_ID, limit: 51 }).success
    ).toBe(false);
    const parsed = citationSourcesSchema.parse({ project_id: PROJECT_ID });
    expect(parsed.limit).toBe(15);
  });

  it("run_prompt_set enforces label, budget, and provider bounds", () => {
    expect(runPromptSetSchema.safeParse(validRun).success).toBe(true);
    expect(runPromptSetSchema.safeParse({ ...validRun, label: "" }).success).toBe(false);
    expect(runPromptSetSchema.safeParse({ ...validRun, budget_usd: 0.1 }).success).toBe(
      false
    );
    expect(runPromptSetSchema.safeParse({ ...validRun, providers: [] }).success).toBe(
      false
    );
    const parsed = runPromptSetSchema.parse(validRun);
    expect(parsed.dry_run).toBe(false);
  });

  it("create_experiment requires a YYYY-MM-DD ship date and valid urls", () => {
    const valid = {
      project_id: PROJECT_ID,
      title: "Comparison page",
      shipped_at: "2026-08-01",
      prompt_set_version_id: VERSION_ID,
    };
    expect(createExperimentSchema.safeParse(valid).success).toBe(true);
    expect(
      createExperimentSchema.safeParse({ ...valid, shipped_at: "01-08-2026" }).success
    ).toBe(false);
    expect(
      createExperimentSchema.safeParse({ ...valid, urls: ["not a url"] }).success
    ).toBe(false);
  });
});

describe("hashArgs", () => {
  it("is stable under key order and undefined omission", () => {
    const a = hashArgs({ b: 1, a: [1, 2], c: { y: 2, x: 1 } });
    const b = hashArgs({ c: { x: 1, y: 2 }, a: [1, 2], b: 1, d: undefined });
    expect(a).toBe(b);
  });

  it("changes when a value changes", () => {
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
  });
});
