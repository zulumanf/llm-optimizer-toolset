/**
 * The audit refresh queue (spec 075): the seeded pending candidate renders
 * as a card whose approval demands the human-finding fields, and the
 * prospects header advertises the queue. Read-only — approving here would
 * mutate shared seed state for the other specs.
 */
import { test, expect } from "@playwright/test";
import { seedState, expectRendered } from "./helpers";

const state = seedState();

test("queue renders the prepared candidate with its controls", async ({ page }) => {
  await page.goto("/prospects/refresh-queue");
  await expectRendered(page);
  await expect(page.locator("h1")).toContainText("Refresh queue");
  // The name also appears inside the finding text — assert the card title.
  await expect(
    page.locator('[data-slot="card-title"]', { hasText: state.refreshProspectName })
  ).toBeVisible();
  await expect(page.getByText(/rec share/i)).toBeVisible();
  await expect(page.getByRole("button", { name: /approve & publish/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /hold/i })).toBeVisible();
  // The attestation fields are present and start from the prior publication
  // (none here — the seed audit shipped without a humanFinding).
  await expect(page.getByLabel(/human finding/i)).toBeVisible();
});

test("prospects header links to the queue with the pending count", async ({ page }) => {
  await page.goto("/prospects");
  const link = page.getByRole("link", { name: /refresh queue · \d+ pending/i });
  await expect(link).toBeVisible();
  await link.click();
  await expect(page.locator("h1")).toContainText("Refresh queue");
});
