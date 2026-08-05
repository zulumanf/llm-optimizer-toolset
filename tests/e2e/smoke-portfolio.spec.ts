/**
 * Every staff surface renders: one h1, no error boundary, no 404 (spec 049).
 * This is the canary — a broken layout, a throwing server component, or a
 * missing gate shows up here before anywhere else.
 */
import { test, expect } from "@playwright/test";
import { expectRendered } from "./helpers";

const SURFACES: { path: string; h1: string | RegExp }[] = [
  { path: "/", h1: "Today" },
  { path: "/work", h1: "Work" },
  { path: "/approvals", h1: /Approvals/i },
  { path: "/projects", h1: /Clients|Projects/i },
  { path: "/prospects", h1: "Prospects" },
  { path: "/control-tower", h1: /Control tower/i },
  { path: "/workflows", h1: /Workflows/i },
  { path: "/automation", h1: /Automation/i },
  { path: "/agents", h1: /Agent/i },
  { path: "/companies", h1: /Companies/i },
  { path: "/exclusivity", h1: /Exclusivity/i },
  { path: "/notifications", h1: /Notifications|Inbox/i },
  { path: "/onboarding", h1: /Onboard/i },
];

for (const surface of SURFACES) {
  test(`${surface.path} renders`, async ({ page }) => {
    await page.goto(surface.path);
    await expectRendered(page);
    await expect(page.locator("h1")).toContainText(surface.h1);
  });
}

test("the seeded client and work items are visible where they should be", async ({ page }) => {
  await page.goto("/projects");
  await expect(page.getByText("Lumina Realty").first()).toBeVisible();

  await page.goto("/work");
  await expect(page.getByText("E2E: fix entity record").first()).toBeVisible();
  await expect(page.getByText("overdue", { exact: false }).first()).toBeVisible();
});
