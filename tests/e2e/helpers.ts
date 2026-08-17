import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page } from "@playwright/test";

export interface SeedState {
  clientProjectId: string;
  prospectId: string;
  auditToken: string;
  refreshProspectName: string;
  suggestedTaskTitle: string;
  overdueTaskTitle: string;
}

export function seedState(): SeedState {
  return JSON.parse(
    readFileSync(join(__dirname, ".seed-state.json"), "utf8")
  ) as SeedState;
}

/** A page rendered, didn't crash, and carries exactly one h1. */
export async function expectRendered(page: Page): Promise<void> {
  await expect(page.locator("body")).not.toContainText("Application error");
  await expect(page.locator("body")).not.toContainText("This page could not be found");
  await expect(page.locator("h1")).toHaveCount(1);
}
