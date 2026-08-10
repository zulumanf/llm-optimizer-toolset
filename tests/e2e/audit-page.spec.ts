/**
 * The prospect-facing audit page — the one surface strangers see (specs
 * 032/045/048 + PR B revision): hero, counted moments, track-record
 * contrast, drawers, appendix, fail-closed tokens, robots noindex.
 */
import { test, expect } from "@playwright/test";
import { seedState } from "./helpers";

const state = seedState();
const auditPath = `/audit/${state.auditToken}`;

test("renders the punch: hero, counted moments, track-record contrast", async ({ page }) => {
  await page.goto(auditPath);
  // Three hero variants exist (named-rival / open-space / legacy headline);
  // all of them talk about answers or name the prospect.
  await expect(page.locator("h1")).toContainText(/answers|recommended|Rivera Team|#9/i);
  // Counted moments (stakes) — the "N× / 0×" pair.
  await expect(page.getByText(/the answer named someone specific to hire/i)).toBeVisible();
  await expect(page.getByText(/it was you/i)).toBeVisible();
  // Provenance claim before any number (PR B).
  await expect(page.getByText(/public records and published AI answers/i)).toBeVisible();
  // The record-vs-visibility contrast in facts — the numeric scorecard is gone.
  await expect(page.getByText(/Track record:/i)).toBeVisible();
  await expect(page.getByText("Documented authority")).toHaveCount(0);
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
    await expect(page.locator("body")).not.toContainText("Track record");
  }
});

test("the page asks not to be indexed", async ({ page }) => {
  await page.goto(auditPath);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    /noindex/
  );
});
