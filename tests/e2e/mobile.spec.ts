/**
 * Mobile-responsive workspace (spec 083): at phone width the sidebar
 * becomes a drawer behind a top bar, and the key operator pages render
 * with no horizontal page scroll. This spec is the fence that keeps the
 * workspace phone-usable as pages evolve.
 */
import { test, expect, type Page } from "@playwright/test";
import { seedState } from "./helpers";

const state = seedState();

test.use({ viewport: { width: 390, height: 844 } });

async function expectNoHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
}

const SURFACES = [
  "/",
  "/prospects",
  "/prospects/refresh-queue",
  "/notifications",
];

for (const path of SURFACES) {
  test(`${path} renders phone-width with no horizontal scroll`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator("body")).not.toContainText("Application error");
    await expectNoHorizontalScroll(page);
  });
}

test("prospect detail renders phone-width with no horizontal scroll", async ({ page }) => {
  await page.goto(`/prospects/${state.prospectId}`);
  await expect(page.locator("h1")).toContainText("Rivera Team");
  await expectNoHorizontalScroll(page);
});

test("the sidebar is a drawer: hidden, opens from the top bar, closes on navigation", async ({
  page,
}) => {
  await page.goto("/prospects");
  // Hidden by default at phone width (top-level nav link, no collapsible).
  await expect(page.getByRole("link", { name: "Clients" })).toBeHidden();
  // Opens from the top-bar menu button.
  await page.getByRole("button", { name: /open menu/i }).click();
  const clientsLink = page.getByRole("link", { name: "Clients" });
  await expect(clientsLink).toBeVisible();
  // Navigating closes it and lands on the page.
  await clientsLink.click();
  await expect(page).toHaveURL(/\/projects/);
  await expect(page.getByRole("link", { name: "Clients" })).toBeHidden();
});
