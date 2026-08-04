/**
 * The prospect workspace: sections render, the published audit exposes its
 * share controls, and the draft dialog opens with a recipient choice
 * (specs 032/046/048).
 */
import { test, expect } from "@playwright/test";
import { seedState, expectRendered } from "./helpers";

const state = seedState();
const path = `/prospects/${state.prospectId}`;

test("detail page renders with the prospect's name", async ({ page }) => {
  await page.goto(path);
  await expectRendered(page);
  await expect(page.locator("h1")).toContainText("Rivera Team");
});

test("published audit shows copy, expire, and revoke controls", async ({ page }) => {
  await page.goto(path);
  await expect(page.getByRole("button", { name: /copy link/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /expire link/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /revoke/i })).toBeVisible();
});

test("copy link puts the APP_URL-based audit link on the clipboard", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(path);
  await page.getByRole("button", { name: /copy link/i }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(`http://localhost:3100/audit/${state.auditToken}`);
});

test("generate-draft opens the recipient dialog when contacts exist, or generates directly", async ({
  page,
}) => {
  await page.goto(path);
  const generate = page.getByRole("button", { name: /generate reply-first draft/i });
  await expect(generate).toBeVisible();
  await generate.click();
  // Seed has no contacts → the button generates directly and toasts.
  await expect(page.getByText(/draft v\d+ generated/i)).toBeVisible({ timeout: 15_000 });
  // The draft carries the audit link (plan 3.1) since APP_URL is set.
  await expect(page.getByText(`http://localhost:3100/audit/${state.auditToken}`)).toBeVisible();
});
