import { describe, expect, it } from "vitest";
import {
  createProjectSchema,
  updateProjectSchema,
  projectIdSchema,
  PROJECT_NAME_MAX,
  PROJECT_DESCRIPTION_MAX,
} from "@/lib/projects/validation";

describe("createProjectSchema", () => {
  it("accepts a valid name and trims whitespace", () => {
    const parsed = createProjectSchema.parse({ name: "  Lumina Core  " });
    expect(parsed.name).toBe("Lumina Core");
    expect(parsed.description).toBeUndefined();
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(createProjectSchema.safeParse({ name: "" }).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: "   " }).success).toBe(false);
  });

  it("rejects a name over the max length and accepts one at the limit", () => {
    expect(
      createProjectSchema.safeParse({ name: "x".repeat(PROJECT_NAME_MAX + 1) })
        .success
    ).toBe(false);
    expect(
      createProjectSchema.safeParse({ name: "x".repeat(PROJECT_NAME_MAX) }).success
    ).toBe(true);
  });

  it("rejects a description over the max length", () => {
    expect(
      createProjectSchema.safeParse({
        name: "ok",
        description: "d".repeat(PROJECT_DESCRIPTION_MAX + 1),
      }).success
    ).toBe(false);
  });

  it("rejects missing name and non-string shapes", () => {
    expect(createProjectSchema.safeParse({}).success).toBe(false);
    expect(createProjectSchema.safeParse({ name: 42 }).success).toBe(false);
    expect(
      createProjectSchema.safeParse({ name: "ok", description: 42 }).success
    ).toBe(false);
  });
});

describe("updateProjectSchema", () => {
  it("requires a uuid id", () => {
    expect(updateProjectSchema.safeParse({ id: "nope", name: "x" }).success).toBe(
      false
    );
    expect(
      updateProjectSchema.safeParse({
        id: "8f14e45f-ceea-4a67-8d5a-4e1f8c9b0a3d",
        name: "x",
      }).success
    ).toBe(true);
  });

  it("allows partial updates", () => {
    const parsed = updateProjectSchema.parse({
      id: "8f14e45f-ceea-4a67-8d5a-4e1f8c9b0a3d",
      description: " new desc ",
    });
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBe("new desc");
  });
});

describe("projectIdSchema", () => {
  it("accepts uuids only", () => {
    expect(projectIdSchema.safeParse({ id: "123" }).success).toBe(false);
    expect(
      projectIdSchema.safeParse({ id: "8f14e45f-ceea-4a67-8d5a-4e1f8c9b0a3d" })
        .success
    ).toBe(true);
  });
});
