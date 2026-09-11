/**
 * Branded audit links (spec 076, exchanged by spec 134): the slug+key URL
 * validates as ever, then lands on the clean /report/<slug> URL; a wrong
 * slug lands on the canonical one; a wrong key reaches only the private
 * state.
 */
import { test, expect } from "@playwright/test";
import { seedState, expectRendered } from "./helpers";

const state = seedState();
const brandedPath = `/audit/${state.auditSlug}/${state.auditKey}`;

test("branded URL renders the prospect's audit", async ({ page }) => {
  await page.goto(brandedPath);
  await expectRendered(page);
  await expect(page.locator("body")).toContainText("Rivera Team");
});

test("wrong slug with a valid key lands on the canonical clean URL", async ({ page }) => {
  await page.goto(`/audit/totally-wrong-name/${state.auditKey}`);
  await expect(page).toHaveURL(new RegExp(`/report/${state.reportSlug}$`));
  await expect(page.locator("body")).toContainText("Rivera Team");
});

test("valid slug with a wrong key shows not-found and leaks nothing", async ({ page }) => {
  // Same invariant as audit-page.spec: streaming can commit a 200 before
  // notFound() renders, so assert the not-found UI and zero prospect data.
  await page.goto(`/audit/${state.auditSlug}/0000000000000000`);
  await expect(page.getByText(/opens from its invitation|could not be found|404/i).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Rivera Team");
  await expect(page.locator("body")).not.toContainText("Track record");
});

test("legacy token URL still works unchanged", async ({ page }) => {
  await page.goto(`/audit/${state.auditToken}`);
  await expectRendered(page);
  await expect(page.locator("body")).toContainText("Rivera Team");
});
