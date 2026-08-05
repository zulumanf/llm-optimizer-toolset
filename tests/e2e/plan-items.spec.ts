/**
 * The 90-day plan is a live work list (plan 5.4): activating an item
 * creates a real task and the item tracks it.
 */
import { test, expect } from "@playwright/test";
import { seedState } from "./helpers";

const state = seedState();

test("a plan item activates into a task and shows as in progress", async ({ page }) => {
  await page.goto(`/projects/${state.clientProjectId}/plan`);
  const activate = page.getByRole("button", { name: /start as task/i }).first();
  await expect(activate).toBeVisible();
  await activate.click();
  await expect(page.getByText(/task created/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("in progress").first()).toBeVisible();
});
