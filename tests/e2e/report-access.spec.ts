/**
 * Spec 134 — private report access, end to end with isolated browser
 * contexts: A (the recipient) clicks the invitation, B (a forwarded-to
 * partner) clicks the same invitation, C (an outsider) pastes the clean URL.
 * Then the operator revokes access and A and B are denied on refresh.
 *
 * Runs after prospect-detail.spec (alphabetical, one worker) because the
 * revocation burns the seed's branded key for good.
 */
import { test, expect as baseExpect, type Browser } from "@playwright/test";

const expect = baseExpect.configure({ timeout: 30_000 });
import { seedState } from "./helpers";

const state = seedState();
// Dev-mode first hits compile the exchange route, the document and the
// appendix in sequence; the production build in CI is instant.
test.setTimeout(90_000);
const invitation = `/report/${state.reportSlug}/${state.auditKey}`;
const clean = `/report/${state.reportSlug}`;

async function fresh(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test("A/B/C: invitation authorizes, forwarding authorizes, the clean URL alone does not", async ({ browser }) => {
  const a = await fresh(browser);
  const b = await fresh(browser);
  const c = await fresh(browser);
  try {
    // A: one click → clean URL, credential gone, report rendered.
    await a.page.goto(invitation);
    await expect(a.page).toHaveURL(new RegExp(`${clean}$`));
    expect(a.page.url()).not.toContain(state.auditKey);
    await expect(a.page.getByText("Private AI recommendation report")).toBeVisible();
    await expect(a.page.locator("body")).toContainText("Rivera Team");
    await expect(a.page.getByText("Private · Not publicly indexed")).toBeVisible();
    // 22: the raw credential is absent from the HTML.
    expect(await a.page.content()).not.toContain(state.auditKey);
    expect(await a.page.content()).not.toContain(state.auditToken);
    // The cookie is HttpOnly and scoped to the report path.
    const cookie = (await a.context.cookies()).find((k) => k.name === `rfr_${state.reportSlug}`);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.path).toBe(clean);
    // Refresh keeps working (same session).
    await a.page.reload();
    await expect(a.page.locator("body")).toContainText("Rivera Team");
    // Sub-pages ride the same session.
    await a.page.getByRole("link", { name: "View the answers", exact: true }).click();
    await expect(a.page).toHaveURL(new RegExp(`${clean}/answers$`));
    await a.page.goto(`${clean}/walkthrough`);
    await expect(a.page.getByRole("heading", { name: /pick a time/i })).toBeVisible();
    expect(await a.page.content()).not.toContain(state.auditToken);

    // B: forwarded original invitation → its own session, same report.
    await b.page.goto(invitation);
    await expect(b.page).toHaveURL(new RegExp(`${clean}$`));
    await expect(b.page.locator("body")).toContainText("Rivera Team");

    // C: only the clean URL → the private state, no report content.
    await c.page.goto(clean);
    await expect(c.page.getByText("This report opens from its invitation.")).toBeVisible();
    await expect(c.page.locator("body")).not.toContainText("Rivera Team");
    await expect(c.page.locator("body")).not.toContainText("Real-world proof");
    await c.page.goto(`${clean}/answers`);
    await expect(c.page.locator("body")).not.toContainText("Rivera Team");
  } finally {
    await Promise.all([a.context.close(), b.context.close(), c.context.close()]);
  }
});

test("legacy /audit links validate, exchange and land on the clean URL", async ({ browser }) => {
  const a = await fresh(browser);
  try {
    await a.page.goto(`/audit/${state.auditToken}`);
    await expect(a.page).toHaveURL(new RegExp(`${clean}$`));
    expect(a.page.url()).not.toContain(state.auditToken);
    await expect(a.page.locator("body")).toContainText("Rivera Team");
    await a.page.goto(`/audit/${state.auditSlug}/${state.auditKey}/answers`);
    await expect(a.page).toHaveURL(new RegExp(`${clean}/answers$`));
  } finally {
    await a.context.close();
  }
});

test("private headers and robots on the report and the exchange", async ({ browser, request }) => {
  const a = await fresh(browser);
  try {
    const head = await request.head(invitation, { maxRedirects: 0 });
    expect(head.status()).toBe(204);
    const exchange = await request.get(invitation, { maxRedirects: 0 });
    expect(exchange.status()).toBe(303);
    expect(exchange.headers()["x-robots-tag"]).toContain("noindex");
    expect(exchange.headers()["cache-control"]).toContain("no-store");
    expect(exchange.headers()["referrer-policy"]).toBe("no-referrer");
    const res = await a.page.goto(invitation);
    expect(res?.headers()["x-robots-tag"]).toContain("noindex");
    expect(res?.headers()["cache-control"]).toContain("no-store");
    await expect(a.page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  } finally {
    await a.context.close();
  }
});

test("revocation denies A and B on refresh and refuses new activations", async ({ browser }) => {
  const a = await fresh(browser);
  const b = await fresh(browser);
  const op = await fresh(browser);
  try {
    await a.page.goto(invitation);
    await b.page.goto(invitation);
    await expect(a.page.locator("body")).toContainText("Rivera Team");
    await expect(b.page.locator("body")).toContainText("Rivera Team");
    // Operator revokes report access (dev auth: every context is staff).
    await op.page.goto(`/prospects/${state.prospectId}`);
    await op.page.getByRole("button", { name: /revoke access/i }).click();
    await expect(op.page.getByText(/report access revoked/i).first()).toBeVisible();
    await a.page.reload();
    await expect(a.page.getByText("This report opens from its invitation.")).toBeVisible();
    await expect(a.page.locator("body")).not.toContainText("Rivera Team");
    await b.page.reload();
    await expect(b.page.locator("body")).not.toContainText("Rivera Team");
    const c = await fresh(browser);
    await c.page.goto(invitation);
    await expect(c.page.locator("body")).not.toContainText("Rivera Team");
    await c.context.close();
  } finally {
    await Promise.all([a.context.close(), b.context.close(), op.context.close()]);
  }
});
