/**
 * The prospect-facing audit page — the one surface strangers see (specs
 * 032/045/048 + PR B revision, rebuilt by spec 123): state-adapted hero,
 * counted moments, who-showed-up-instead, track-record contrast, drawers,
 * verify-it-yourself appendix, fail-closed tokens, robots noindex.
 */
import { test, expect } from "@playwright/test";
import { seedState } from "./helpers";

const state = seedState();
const auditPath = `/audit/${state.auditToken}`;

test("renders the punch: hero, counted moments, track-record contrast", async ({ page }) => {
  await page.goto(auditPath);
  // Narrative-state headlines (zero/low/strong/leader) all speak in counted
  // recommendations; the legacy fallback names the prospect.
  await expect(page.locator("h1")).toContainText(/recommended|recommendation|Rivera Team/i);
  // Counted moments (stakes) — mention units stated at the number (spec 090).
  await expect(
    page.getByText(/explicit recommendations — of a team, agent, or brokerage/i)
  ).toBeVisible();
  await expect(page.getByText(/^(was|were) you\.$/i)).toBeVisible();
  await expect(page.getByText(/mentions outnumber answers/i)).toBeVisible();
  // Provenance claim before any number (PR B).
  await expect(page.getByText(/public records and published AI answers/i)).toBeVisible();
  // The reputation-vs-AI-presence contrast in facts — no numeric scorecard.
  await expect(page.getByText(/Track record:/i)).toBeVisible();
  await expect(page.getByText("Documented authority")).toHaveCount(0);
});

test("the competitor list puts the prospect's own row at the bottom, unmistakable", async ({
  page,
}) => {
  await page.goto(auditPath);
  await expect(page.getByText(/the answers recommended/i).first()).toBeVisible();
  await expect(page.getByText(/Rivera Team ← you/).first()).toBeVisible();
});

test("the CTA is one action with the commitment bar stated", async ({ page }) => {
  await page.goto(auditPath);
  const cta = page.getByRole("link", { name: "Show me the plan" });
  // Repeated top and bottom (prospect-voice), same label, same intent.
  await expect(cta).toHaveCount(2);
  await expect(page.getByText(/15 minutes · no deck · no obligation/i).first()).toBeVisible();
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
  const methodology = page.locator("summary", { hasText: /how we ran the test/i });
  await expect(methodology).toBeVisible();
  // Collapsed by default — the details live behind the click.
  await expect(page.getByText(/How to read this report/i)).toBeHidden();
  await methodology.click();
  await expect(page.getByText(/captured verbatim|probabilistic/i).first()).toBeVisible();
  await expect(page.getByText(/How to read this report/i)).toBeVisible();
  // The signature line — anonymous analysis reads as spam (prospect-voice).
  await expect(page.getByText(/Prepared by/i)).toBeVisible();
});

test("the verify-it-yourself section serves the captured answers", async ({ page }) => {
  await page.goto(auditPath);
  await expect(page.getByText("Want to verify it yourself?")).toBeVisible();
  // Honest metadata: the page states how many answers are published.
  await expect(page.getByText(/captured answers are published/i)).toBeVisible();
  const appendix = page.getByRole("link", { name: "View the answers", exact: true });
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

test("phone width: the finding is readable with no horizontal scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(auditPath);
  await expect(page.locator("h1")).toBeVisible();
  await expect(
    page.getByText(/explicit recommendations — of a team, agent, or brokerage/i)
  ).toBeVisible();
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});
