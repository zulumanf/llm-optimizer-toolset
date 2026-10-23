/**
 * Spec 154 — client delivery surfaces, desktop and phone width, over the
 * synthetic rehearsal seed (scripts/client-delivery-rehearsal.ts):
 *  - every portal area and the operator delivery page render, no crash;
 *  - no horizontal page scroll at 390px;
 *  - the pending client never shows a percentage or a "0%" result;
 *  - the measured client shows counts with their denominator and caveats;
 *  - approvals show the exact proposed wording; drafts never appear.
 * Dev auth is staff, so this checks rendering; client-role scoping is
 * covered by tests/integration/client-delivery.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type Page } from "@playwright/test";

const state = JSON.parse(readFileSync(join(__dirname, ".delivery-state.json"), "utf8")) as { pendingProjectId: string; deliveryProjectId: string };
const P = state.pendingProjectId;
const D = state.deliveryProjectId;

async function noHorizontalScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

const PORTAL = ["", "/results", "/plan", "/approvals", "/reports"];

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test.describe(`client delivery at ${viewport.width}px`, () => {
    test.use({ viewport });

    for (const path of PORTAL) {
      test(`portal${path || " overview"} renders for both synthetic clients`, async ({ page }) => {
        for (const id of [P, D]) {
          await page.goto(`/portal/${id}${path}`);
          await expect(page.locator("body")).not.toContainText("Application error");
          await expect(page.locator("body")).not.toContainText("This page could not load");
          await noHorizontalScroll(page);
        }
      });
    }

    test("operator delivery page renders", async ({ page }) => {
      await page.goto(`/projects/${D}/delivery`);
      await expect(page.locator("body")).not.toContainText("Application error");
      await expect(page.getByText("Next step")).toBeVisible();
      await noHorizontalScroll(page);
    });
  });
}

test("pending client: results are pending, never a number", async ({ page }) => {
  await page.goto(`/portal/${P}`);
  // Spec 155 overview: four sections; before the baseline it says so in words.
  await expect(page.getByText("We're establishing your starting point.").first()).toBeVisible();
  const overview = await page.locator("main, body").first().innerText();
  expect(overview).not.toMatch(/\d+(\.\d+)?%/);
  await page.goto(`/portal/${P}/results`);
  expect(await page.locator("body").innerText()).not.toMatch(/\d+(\.\d+)?%/);
});

test("measured client: counts carry denominator and caveats; no unmeasured change", async ({ page }) => {
  await page.goto(`/portal/${D}`);
  for (const title of ["This week's focus", "Progress", "Needs your attention", "Latest update"]) {
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
  }
  await page.goto(`/portal/${D}/results`);
  await expect(page.getByText(/Recommended in \d+ of 64 answers/).first()).toBeVisible();
  await expect(page.getByText(/No later comparable measurement yet/)).toBeVisible();
  await expect(page.getByText("What these numbers do and don't mean")).toBeVisible();
  await expect(page.getByRole("table", { name: "Recommendations by price band" })).toBeVisible();
});

test("approvals show exact wording; weekly drafts never leak", async ({ page }) => {
  await page.goto(`/portal/${D}/approvals`);
  await expect(page.getByText("Exact proposed wording")).toBeVisible();
  await expect(page.getByText("Waiting for you").first()).toBeVisible();
  await page.goto(`/portal/${D}/reports`);
  await expect(page.getByText("Weekly update").first()).toBeVisible();
  await expect(page.locator("body")).not.toContainText("not sent");
});

test("an answer outside this client's evidence is not shown", async ({ page }) => {
  await page.goto(`/portal/${D}/answers/00000000-0000-4000-8000-00000000abcd`);
  await expect(page.locator("body")).not.toContainText("Original answer, unedited");
});
