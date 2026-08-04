/**
 * The sidebar's two states hold (spec 037): portfolio map navigates, and
 * entering a client shows the reading-order groups with the escape hatch.
 */
import { test, expect } from "@playwright/test";
import { seedState } from "./helpers";

const state = seedState();

test("portfolio sidebar navigates to Work and Clients", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Work", exact: true }).click();
  await page.waitForURL("**/work");
  await expect(page.locator("h1")).toContainText("Work");

  await page.getByRole("link", { name: "Clients", exact: true }).click();
  await page.waitForURL("**/projects");
});

test("project sidebar shows the reading order incl. Activity, and the escape", async ({
  page,
}) => {
  await page.goto(`/projects/${state.clientProjectId}`);
  await expect(page.getByRole("link", { name: "Activity" })).toBeVisible();
  await expect(page.getByRole("link", { name: /all clients/i })).toBeVisible();
});
