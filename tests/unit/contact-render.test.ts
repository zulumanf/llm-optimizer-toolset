/**
 * BROWSER_RESOURCES_CLOSED (pipeline hardening 2026-09-14): every render
 * closes its page and context on every exit path, the shared browser closes
 * itself after the idle window, and `withRenderer` closes it however the
 * block ends. A fake launcher records every lifecycle call; nothing here
 * touches a real Chromium.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeRenderer,
  IDLE_CLOSE_MS,
  renderPageHtml,
  rendererIsOpen,
  setRendererLauncherForTests,
  withRenderer,
  type RenderBrowser,
  type RenderPage,
} from "@/lib/prospects/contact-render";

type Log = string[];

function fakeBrowser(log: Log, behavior: { goto?: () => Promise<{ status(): number } | null>; content?: () => Promise<string>; newPageFails?: boolean }): RenderBrowser {
  const page: RenderPage = {
    route: async () => undefined,
    goto: behavior.goto ?? (async () => ({ status: () => 200 })),
    content: behavior.content ?? (async () => "<html>ok</html>"),
    close: async () => { log.push("page.close"); },
  };
  return {
    newContext: async () => {
      log.push("context.open");
      return {
        newPage: async () => {
          if (behavior.newPageFails) throw new Error("newPage failed");
          log.push("page.open");
          return page;
        },
        close: async () => { log.push("context.close"); },
      };
    },
    close: async () => { log.push("browser.close"); },
  };
}

describe("renderPageHtml resource lifecycle", () => {
  let log: Log;
  beforeEach(() => { log = []; vi.useFakeTimers(); });
  afterEach(async () => { await closeRenderer(); setRendererLauncherForTests(null); vi.useRealTimers(); });

  it("success: page and context close, browser stays for the idle window then closes itself", async () => {
    setRendererLauncherForTests(async () => { log.push("browser.launch"); return fakeBrowser(log, {}); });
    const r = await renderPageHtml("https://example.test/");
    expect(r.status).toBe(200);
    expect(log).toEqual(["browser.launch", "context.open", "page.open", "page.close", "context.close"]);
    expect(rendererIsOpen()).toBe(true);
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS + 1);
    expect(log.at(-1)).toBe("browser.close");
    expect(rendererIsOpen()).toBe(false);
  });

  it("navigation throws: page and context still close, error propagates", async () => {
    setRendererLauncherForTests(async () => fakeBrowser(log, { goto: async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); } }));
    await expect(renderPageHtml("https://nope.test/")).rejects.toThrow(/ERR_NAME_NOT_RESOLVED/);
    expect(log).toEqual(["context.open", "page.open", "page.close", "context.close"]);
  });

  it("timeout: a hung content() is cut by the hang guard and resources close", async () => {
    setRendererLauncherForTests(async () => fakeBrowser(log, { content: () => new Promise<string>(() => undefined) }));
    const p = renderPageHtml("https://hang.test/");
    const assertion = expect(p).rejects.toThrow(/page\.content exceeded/);
    await vi.advanceTimersByTimeAsync(11_000);
    await assertion;
    expect(log.slice(-2)).toEqual(["page.close", "context.close"]);
  });

  it("early failure before a page exists: the context still closes", async () => {
    setRendererLauncherForTests(async () => fakeBrowser(log, { newPageFails: true }));
    await expect(renderPageHtml("https://early.test/")).rejects.toThrow(/newPage failed/);
    expect(log).toEqual(["context.open", "context.close"]);
  });

  it("a render during the idle window re-arms the timer instead of closing mid-flight", async () => {
    setRendererLauncherForTests(async () => fakeBrowser(log, {}));
    await renderPageHtml("https://a.test/");
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS - 100);
    await renderPageHtml("https://b.test/");
    expect(log.filter((l) => l === "browser.close")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(IDLE_CLOSE_MS + 1);
    expect(log.filter((l) => l === "browser.close")).toHaveLength(1);
  });
});

describe("withRenderer / closeRenderer", () => {
  let log: Log;
  beforeEach(() => { log = []; });
  afterEach(async () => { await closeRenderer(); setRendererLauncherForTests(null); });

  it("closes the browser when the block returns", async () => {
    setRendererLauncherForTests(async () => fakeBrowser(log, {}));
    const out = await withRenderer(async () => { await renderPageHtml("https://x.test/"); return "done"; });
    expect(out).toBe("done");
    expect(log.at(-1)).toBe("browser.close");
    expect(rendererIsOpen()).toBe(false);
  });

  it("closes the browser when the block throws, and rethrows", async () => {
    setRendererLauncherForTests(async () => fakeBrowser(log, {}));
    await expect(withRenderer(async () => { await renderPageHtml("https://x.test/"); throw new Error("verification miss"); })).rejects.toThrow(/verification miss/);
    expect(log.at(-1)).toBe("browser.close");
  });

  it("closes the browser when the block returns early without rendering (never launched → nothing to close)", async () => {
    let launches = 0;
    setRendererLauncherForTests(async () => { launches += 1; return fakeBrowser(log, {}); });
    await withRenderer(async () => "early");
    expect(launches).toBe(0);
    expect(rendererIsOpen()).toBe(false);
  });

  it("closeRenderer is idempotent and tolerates a wedged close", async () => {
    const wedged: RenderBrowser = { ...fakeBrowser(log, {}), close: () => new Promise<void>(() => undefined) };
    setRendererLauncherForTests(async () => wedged);
    vi.useFakeTimers();
    await renderPageHtml("https://x.test/");
    const closing = closeRenderer();
    await vi.advanceTimersByTimeAsync(11_000);
    await closing;
    await closeRenderer();
    expect(rendererIsOpen()).toBe(false);
    vi.useRealTimers();
  });
});
