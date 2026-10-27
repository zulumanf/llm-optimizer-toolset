/**
 * Spec 157: one-click unsubscribe (RFC 8058). Token issue, redemption,
 * uniform answers (no validity oracle), GET-never-unsubscribes, survival
 * across a send-transaction rollback, and the public confirmation page.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ONE_CLICK = "List-Unsubscribe=One-Click";

describe.skipIf(!TEST_URL)("one-click unsubscribe (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let unsub: typeof import("@/lib/outreach/unsubscribe");
  let suppression: typeof import("@/lib/outreach/suppression");
  let route: typeof import("@/app/api/unsubscribe/[token]/route");
  const savedAppUrl = process.env.APP_URL;

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    unsub = await import("@/lib/outreach/unsubscribe");
    suppression = await import("@/lib/outreach/suppression");
    route = await import("@/app/api/unsubscribe/[token]/route");
  });
  beforeEach(async () => {
    await truncateAll(sql);
    process.env.APP_URL = "https://app.test.local";
  });
  afterAll(async () => {
    if (savedAppUrl === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = savedAppUrl;
    await sql.end();
  });

  const post = (token: string, body: string) =>
    route.POST(
      new Request(`https://app.test.local/api/unsubscribe/${token}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
      { params: Promise.resolve({ token }) }
    );
  const suppressions = async () =>
    sql`select scope, normalized_value, reason, project_id, detail from suppression_entries`;

  it("issues a token (normalized address) and refuses without APP_URL", async () => {
    const link = await unsub.issueUnsubscribeLink({ recipientEmail: "Ana+t1@RiveraTeam.com", prospectId: null, draftId: null });
    expect(link?.url).toBe(`https://app.test.local/api/unsubscribe/${link?.token}`);
    const [row] = await sql`select recipient_email from outreach_unsubscribe_tokens where token = ${link!.token}`;
    expect(row?.recipientEmail).toBe("ana@riverateam.com");
    delete process.env.APP_URL;
    expect(await unsub.issueUnsubscribeLink({ recipientEmail: "x@y.com", prospectId: null, draftId: null })).toBeNull();
  });

  it("one-click POST suppresses globally (opt_out, audited); repeat is a no-op; later sends are suppressed", async () => {
    const link = await unsub.issueUnsubscribeLink({ recipientEmail: "ana@riverateam.com", prospectId: null, draftId: null });
    const first = await post(link!.token, ONE_CLICK);
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("Unsubscribed.\n");
    const rows = await suppressions();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ scope: "email", normalizedValue: "ana@riverateam.com", reason: "opt_out", projectId: null });
    const [audit] = await sql`select user_id from audit_log where action = 'outreach.suppressed'`;
    expect(audit).toBeDefined();
    expect(audit?.userId).toBeNull();

    const again = await post(link!.token, ONE_CLICK);
    expect(again.status).toBe(200);
    expect(await suppressions()).toHaveLength(1);
    expect((await suppression.checkSuppression({ email: "Ana@RiveraTeam.com" })).suppressed).toBe(true);
  });

  it("unknown and malformed tokens get the identical answer and write nothing", async () => {
    const link = await unsub.issueUnsubscribeLink({ recipientEmail: "ana@riverateam.com", prospectId: null, draftId: null });
    const valid = await post(link!.token, ONE_CLICK);
    const unknown = await post("f".repeat(32), ONE_CLICK);
    const malformed = await post("not-a-token';--", ONE_CLICK);
    for (const r of [unknown, malformed]) {
      expect(r.status).toBe(valid.status);
      expect(await r.text()).toBe("Unsubscribed.\n");
    }
    expect(await suppressions()).toHaveLength(1); // only the valid one
  });

  it("GET never unsubscribes; it redirects to the confirmation page", async () => {
    const link = await unsub.issueUnsubscribeLink({ recipientEmail: "ana@riverateam.com", prospectId: null, draftId: null });
    const res = await route.GET(new Request(`https://app.test.local/api/unsubscribe/${link!.token}`), {
      params: Promise.resolve({ token: link!.token }),
    });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/unsubscribe/${link!.token}`);
    expect(await suppressions()).toHaveLength(0);
  });

  it("browser form: confirm=1 suppresses and redirects to done; a bare POST does neither", async () => {
    const link = await unsub.issueUnsubscribeLink({ recipientEmail: "ana@riverateam.com", prospectId: null, draftId: null });
    const bare = await post(link!.token, "");
    expect(bare.status).toBe(303);
    expect(bare.headers.get("location")).toBe(`/unsubscribe/${link!.token}`);
    expect(await suppressions()).toHaveLength(0);
    const confirmed = await post(link!.token, "confirm=1");
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get("location")).toBe(`/unsubscribe/${link!.token}?done=1`);
    expect(await suppressions()).toHaveLength(1);
  });

  it("a token survives a rollback of the surrounding send transaction, and is insert-only", async () => {
    let token = "";
    await expect(
      sql.begin(async (tx) => {
        await tx`select 1`;
        token = (await unsub.issueUnsubscribeLink({ recipientEmail: "ana@riverateam.com", prospectId: null, draftId: null }))!.token;
        throw new Error("ledger failed after dispatch");
      })
    ).rejects.toThrow(/ledger failed/);
    const [row] = await sql`select token from outreach_unsubscribe_tokens where token = ${token}`;
    expect(row?.token).toBe(token);
    await expect(sql`update outreach_unsubscribe_tokens set recipient_email = 'x@y.com'`).rejects.toThrow(/immutable|forbid/i);
  });

  it("the public page shows no address, posts to the endpoint, and confirms when done", async () => {
    // Vitest compiles JSX in classic mode (global React); Next uses the
    // automatic runtime, so the page itself needs no import.
    (globalThis as { React?: unknown }).React = await import("react");
    const { default: Page } = await import("@/app/unsubscribe/[token]/page");
    const token = "a".repeat(32);
    const ask = renderToStaticMarkup(await Page({ params: Promise.resolve({ token }), searchParams: Promise.resolve({}) }));
    expect(ask).toContain(`action="/api/unsubscribe/${token}"`);
    expect(ask).toContain('name="confirm"');
    expect(ask).not.toMatch(/@/);
    const done = renderToStaticMarkup(await Page({ params: Promise.resolve({ token }), searchParams: Promise.resolve({ done: "1" }) }));
    expect(done).toContain("You are unsubscribed");
    expect(done).not.toContain("<form");
  });
});
