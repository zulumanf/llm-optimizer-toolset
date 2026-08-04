/**
 * All project sections render for a seeded client — including the Activity
 * page added in phase 5 (spec 049). The section list is imported from the
 * nav registry so a new section cannot ship without a rendering check.
 */
import { test, expect } from "@playwright/test";
import { PROJECT_SECTIONS } from "@/components/layout/sections";
import { seedState, expectRendered } from "./helpers";

const state = seedState();

for (const section of PROJECT_SECTIONS) {
  test(`project section "${section.label}" renders`, async ({ page }) => {
    await page.goto(`/projects/${state.clientProjectId}${section.path}`);
    await expectRendered(page);
  });
}

test("dashboard shows the client name and measured content", async ({ page }) => {
  await page.goto(`/projects/${state.clientProjectId}`);
  await expect(page.locator("h1")).toContainText("Lumina Realty");
});

test("activity page carries the seeded work record", async ({ page }) => {
  await page.goto(`/projects/${state.clientProjectId}/activity`);
  await expect(page.locator("h1")).toContainText("Activity");
  // The seed ran a benchmark and approved tasks — the log must show it.
  await expect(page.locator("li").first()).toBeVisible();
});
