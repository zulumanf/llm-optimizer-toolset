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

test("sense-check panel renders the stored concern (spec 077)", async ({ page }) => {
  await page.goto(path);
  await expect(page.getByText(/sense-check — a second read/i)).toBeVisible();
  await expect(page.getByText("E2E seeded concern: headline overstates the table.")).toBeVisible();
  await expect(page.getByRole("button", { name: /re-run/i })).toBeVisible();
});

test("copy link prefers the branded audit URL (spec 076)", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(path);
  await page.getByRole("button", { name: /copy link/i }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(
    `http://localhost:3100/audit/${state.auditSlug}/${state.auditKey}`
  );
});

test("generate-draft opens the recipient dialog when contacts exist, or generates directly", async ({
  page,
}) => {
  await page.goto(path);
  // The button dropped "reply-first" when it learned the competitive-mismatch
  // template (spec 124); with no seeded contacts there is exactly one.
  const generate = page.getByRole("button", { name: /^generate draft$/i });
  await expect(generate).toBeVisible();
  await generate.click();
  // Seed has no contacts → the button generates directly and toasts.
  await expect(page.getByText(/draft v\d+ generated/i)).toBeVisible({ timeout: 15_000 });
  // The draft carries the audit link (plan 3.1) since APP_URL is set.
  // Drafts embed the branded URL now (spec 076).
  await expect(
    page.getByText(
      `http://localhost:3100/audit/${state.auditSlug}/${state.auditKey}`
    )
  ).toBeVisible();
});

test("editing a draft saves a new version through the gated pipeline (plan 3.2)", async ({
  page,
}) => {
  // Depends on the draft the previous test generated (workers: 1, serial).
  await page.goto(path);
  await page.getByRole("button", { name: /^edit$/i }).first().click();
  const subject = page.getByLabel("Subject");
  await expect(subject).toBeVisible();
  await subject.fill("A benchmark result worth two minutes");
  await page.getByRole("button", { name: /save new version/i }).click();
  await expect(page.getByText(/saved as v2/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("A benchmark result worth two minutes").first()).toBeVisible();
});
