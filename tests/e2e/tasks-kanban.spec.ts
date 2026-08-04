/**
 * The task lifecycle through the actual UI: approve → start → complete on
 * the kanban (spec 049). Serial by design — these mutate the shared seed.
 */
import { test, expect } from "@playwright/test";
import { seedState } from "./helpers";

const state = seedState();

test("a suggested task moves suggested → approved → in progress → done", async ({ page }) => {
  await page.goto(`/projects/${state.clientProjectId}/tasks`);
  // The tightest per-card container is the shadcn CardContent (p-3);
  // ancestor divs would match half the page.
  const card = () =>
    page.locator("div.p-3").filter({ hasText: state.suggestedTaskTitle }).first();
  await expect(card()).toBeVisible();

  await card().getByRole("button", { name: /approve/i }).click();
  await expect(card().getByRole("button", { name: /^start$/i })).toBeVisible();

  await card().getByRole("button", { name: /^start$/i }).click();
  await expect(card().getByRole("button", { name: /^done$/i })).toBeVisible();
});
