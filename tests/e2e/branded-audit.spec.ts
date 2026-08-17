/**
 * Branded audit links (spec 076): the slug+key URL renders the same audit
 * as the legacy token URL, a wrong slug redirects to the canonical one, and
 * a wrong key gets an indistinguishable 404.
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

test("wrong slug with a valid key redirects to the canonical slug", async ({ page }) => {
  await page.goto(`/audit/totally-wrong-name/${state.auditKey}`);
  await expect(page).toHaveURL(new RegExp(`/audit/${state.auditSlug}/${state.auditKey}$`));
  await expect(page.locator("body")).toContainText("Rivera Team");
});

test("valid slug with a wrong key shows not-found and leaks nothing", async ({ page }) => {
  // Same invariant as audit-page.spec: streaming can commit a 200 before
  // notFound() renders, so assert the not-found UI and zero prospect data.
  await page.goto(`/audit/${state.auditSlug}/0000000000000000`);
  await expect(page.getByText(/could not be found|404/i).first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Rivera Team");
  await expect(page.locator("body")).not.toContainText("Track record");
});

test("legacy token URL still works unchanged", async ({ page }) => {
  await page.goto(`/audit/${state.auditToken}`);
  await expectRendered(page);
  await expect(page.locator("body")).toContainText("Rivera Team");
});
