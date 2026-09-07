/**
 * The prospect-facing audit page — the one surface strangers see (specs
 * 032/045/048, rebuilt by spec 123 rounds 1+2): prospect-centric hero with
 * the large recommendation count, competitor contrast, reputation-vs-AI
 * contrast, single CTA promise, collapsed proof, fail-closed tokens,
 * robots noindex.
 */
import { test, expect } from "@playwright/test";
import { seedState } from "./helpers";

const state = seedState();
const auditPath = `/audit/${state.auditToken}`;

test("renders the punch: hero number, counted moments, reputation contrast", async ({ page }) => {
  await page.goto(auditPath);
  await expect(page.getByText("Private AI recommendation report")).toBeVisible();
  // Narrative-state headlines (zero/low/strong/leader) all speak in counted
  // recommendations; the legacy fallback names the prospect.
  await expect(page.locator("h1")).toContainText(/recommend|Rivera Team/i);
  // The hero's one large number with its plain label and one denominator.
  await expect(page.locator("p.text-6xl")).toBeVisible();
  await expect(page.getByText(/^recommendations?$/)).toBeVisible();
  await expect(page.getByText(/answers we tested/i).first()).toBeVisible();
  // Counted moments — mention units stated at the number (spec 090).
  await expect(
    page.getByText(/explicit recommendations — of a team, agent, or brokerage/i)
  ).toBeVisible();
  await expect(page.getByText(/\d+ (was|were) you\./i)).toBeVisible();
  await expect(page.getByText(/mentions outnumber answers/i)).toBeVisible();
  // The reputation-vs-AI-presence contrast in facts.
  await expect(page.getByText(/Real-world proof:/i)).toBeVisible();
  await expect(page.getByText("Documented authority")).toHaveCount(0);
});

test("no stray artifacts: no visible 'svg' text, no empty drawer labels", async ({
  page,
}) => {
  await page.goto(auditPath);
  const text = await page.evaluate(() => document.body.innerText);
  expect(text).not.toMatch(/\bsvg/i);
  expect(text).not.toContain("undefined");
  expect(text).not.toContain("NaN");
});

test("the competitor contrast puts the prospect's own row last, unmistakable", async ({
  page,
}) => {
  await page.goto(auditPath);
  await expect(
    page.getByRole("heading", { name: /recommended/i }).first()
  ).toBeVisible();
  await expect(page.getByText(/Rivera Team ← you/).first()).toBeVisible();
});

test("one CTA promise, repeated with identical wording and commitment bar", async ({
  page,
}) => {
  await page.goto(auditPath);
  const cta = page.getByRole("link", { name: "Show me the plan" });
  await expect(cta).toHaveCount(2);
  await expect(page.getByText(/15 minutes · no obligation/i).first()).toBeVisible();
});

test("what-we-do states the offer in three steps", async ({ page }) => {
  await page.goto(auditPath);
  await expect(
    page.getByText(/more likely to be recommended when buyers and sellers ask AI/i)
  ).toBeVisible();
  await expect(page.getByText("1. Find the gaps")).toBeVisible();
  await expect(page.getByText("2. Fix the information")).toBeVisible();
  await expect(page.getByText("3. Keep measuring")).toBeVisible();
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

test("proof stays collapsed by default; drawers disclose receipts", async ({ page }) => {
  await page.goto(auditPath);
  // Methodology and limitations are folded until opened.
  await expect(page.getByText(/How to read this report/i)).toBeHidden();
  const methodology = page.locator("summary", { hasText: /how we ran the test/i });
  await expect(methodology).toBeVisible();
  await methodology.click();
  await expect(page.getByText(/captured verbatim|probabilistic/i).first()).toBeVisible();
  const limitations = page.locator("summary", { hasText: /^Limitations$/ });
  await limitations.click();
  await expect(page.getByText(/How to read this report/i)).toBeVisible();
  await expect(page.getByText(/public records and published AI answers/i)).toBeVisible();
  // The signature line — anonymous analysis reads as spam (prospect-voice).
  await expect(page.getByText(/Prepared by/i)).toBeVisible();
});

test("the verify section serves the captured answers with honest metadata", async ({
  page,
}) => {
  await page.goto(auditPath);
  await expect(page.getByText("Want to verify the data?")).toBeVisible();
  // Honest metadata: an exact answer count, either provably complete
  // ("All N captured answers are published") or shown-of-total.
  await expect(
    page.getByText(/answers are published|published answers/i).first()
  ).toBeVisible();
  const appendix = page.getByRole("link", { name: "View the answers", exact: true });
  await expect(appendix).toBeVisible();
  await appendix.click();
  // Spec 134: the legacy token rides the exchange to the clean URL.
  await page.waitForURL(`**/report/${state.reportSlug}/answers`);
  await expect(page.getByText(/every captured answer, verbatim/i)).toBeVisible();
});

test("wrong and truncated tokens show not-found and leak nothing", async ({ page }) => {
  // Dev-mode streaming can commit a 200 before notFound() renders, so the
  // invariant asserted is the one that matters: the not-found UI, and zero
  // prospect data in the body.
  for (const bad of ["x".repeat(43), "short"]) {
    await page.goto(`/audit/${bad}`);
    // Spec 134: an unknown credential lands on the private-report state.
    await expect(page.getByText(/opens from its invitation|could not be found|404/i).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText("Rivera Team");
    await expect(page.locator("body")).not.toContainText("Real-world proof");
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
  await expect(page.locator("p.text-6xl")).toBeVisible();
  const overflow = await page.evaluate(() => {
    const el = document.documentElement;
    return el.scrollWidth - el.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(1);
});
