/**
 * The prospect-facing audit page — the one surface strangers see (specs
 * 032/045/048): hero, counted moments, scorecard, drawers, appendix,
 * fail-closed tokens, robots noindex.
 */
import { test, expect } from "@playwright/test";
import { seedState } from "./helpers";

const state = seedState();
const auditPath = `/audit/${state.auditToken}`;

test("renders the punch: prospect name, counted moments, scorecard", async ({ page }) => {
  await page.goto(auditPath);
  await expect(page.locator("h1")).toContainText(/Rivera Team|#9/);
  // Counted moments (stakes) — the "N× / 0×" pair.
  await expect(page.getByText(/AI recommended a specific team/i)).toBeVisible();
  await expect(page.getByText(/it was you/i)).toBeVisible();
  // Scorecard tiles from computed scores (spec 048).
  await expect(page.getByText("Documented authority").first()).toBeVisible();
  await expect(page.getByText("AI visibility").first()).toBeVisible();
});

test("the document carries no workspace chrome, even for a signed-in operator", async ({
  page,
}) => {
  // AUTH_MODE=dev makes every E2E request a staff session — exactly the
  // case that used to leak the sidebar (with other clients' names) around
  // the prospect document.
  await page.goto(auditPath);
  await expect(page.getByRole("navigation")).toHaveCount(0);
  await expect(page.getByText("Active clients")).toHaveCount(0);
  await expect(page.getByText("Lumina Realty")).toHaveCount(0);
});

test("the second read folds open: drawers disclose, receipts intact", async ({ page }) => {
  await page.goto(auditPath);
  const methodology = page.locator("summary", { hasText: /how this was measured/i });
  await expect(methodology).toBeVisible();
  await methodology.click();
  await expect(page.getByText(/captured verbatim|probabilistic/i).first()).toBeVisible();
  // The signature line — anonymous analysis reads as spam (prospect-voice).
  await expect(page.getByText(/Prepared by/i)).toBeVisible();
});

test("the appendix link serves every captured answer", async ({ page }) => {
  await page.goto(auditPath);
  const appendix = page.getByRole("link", { name: /read all .* answers/i });
  await expect(appendix).toBeVisible();
  await appendix.click();
  await page.waitForURL(`**${auditPath}/answers`);
  await expect(page.getByText(/every captured answer, verbatim/i)).toBeVisible();
});

test("wrong and truncated tokens show not-found and leak nothing", async ({ page }) => {
  // Dev-mode streaming can commit a 200 before notFound() renders, so the
  // invariant asserted is the one that matters: the not-found UI, and zero
  // prospect data in the body.
  for (const bad of ["x".repeat(43), "short"]) {
    await page.goto(`/audit/${bad}`);
    await expect(page.getByText(/could not be found|404/i).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Rivera Team");
    await expect(page.locator("body")).not.toContainText("Documented authority");
  }
});

test("the page asks not to be indexed", async ({ page }) => {
  await page.goto(auditPath);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    /noindex/
  );
});
