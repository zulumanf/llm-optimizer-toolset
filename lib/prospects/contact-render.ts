/**
 * Rendered-page fetch for contact discovery (2026-09-14): a public page
 * that serves a JS shell to a plain fetch is rendered headlessly (same
 * Playwright Chromium the video lane uses) so its literal contact card can
 * be read. Normal public access only — no logins, no CAPTCHA solving, no
 * private APIs; a challenge page is reported as blocked, never bypassed.
 *
 * Resource lifecycle (hardening 2026-09-14): a leaked Chromium kept a
 * 26-second promotion alive for 14 minutes. Three structural guards, none
 * of which depends on a caller remembering anything:
 *   1. every context/page is closed in `finally` — success, miss, throw,
 *      timeout, early return alike; a page that cannot be created still
 *      closes its context;
 *   2. the shared browser auto-closes after IDLE_CLOSE_MS without a render
 *      (an unref'd timer, so the timer itself never keeps Node alive);
 *   3. `withRenderer(fn)` scopes the browser to a block and closes it in
 *      `finally`; scripts wrap their main in it (or call closeRenderer in
 *      their own finally).
 */
import { ClassifiedError } from "@/lib/errors";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
export const RENDER_TIMEOUT_MS = 25_000;
/** Idle window after the last render before the browser closes itself. */
export const IDLE_CLOSE_MS = 15_000;
/** Ceiling on page.content()/close() so a wedged renderer cannot hang a run. */
const HANG_GUARD_MS = 10_000;

type Route = { abort(): Promise<void>; continue(): Promise<void> };
type Request = { resourceType(): string };
export type RenderPage = {
  goto(url: string, o: { waitUntil: "domcontentloaded" | "networkidle"; timeout: number }): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  close(): Promise<void>;
  route(pattern: string, handler: (route: Route, request: Request) => Promise<void>): Promise<void>;
};
export type RenderContext = { newPage(): Promise<RenderPage>; close(): Promise<void> };
export type RenderBrowser = { newContext(o: { userAgent: string }): Promise<RenderContext>; close(): Promise<void> };
export type RenderLauncher = () => Promise<RenderBrowser>;

let browser: RenderBrowser | null = null;
let opening: Promise<RenderBrowser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let inFlight = 0;
let launcher: RenderLauncher | null = null;

async function defaultLauncher(): Promise<RenderBrowser> {
  let mod: { chromium: { launch(o: { headless: boolean }): Promise<RenderBrowser> } };
  try {
    mod = (await import("@playwright/test")) as unknown as typeof mod;
  } catch {
    throw new ClassifiedError("internal", "Playwright is not installed — rendered discovery unavailable.");
  }
  return mod.chromium.launch({ headless: true });
}

/** Test seam: substitute the browser factory. Pass null to restore Playwright. */
export function setRendererLauncherForTests(next: RenderLauncher | null): void {
  launcher = next;
}

/** Test seam: live browser handle (null once closed). */
export function rendererIsOpen(): boolean {
  return browser !== null;
}

async function open(): Promise<RenderBrowser> {
  if (browser) return browser;
  if (!opening) {
    opening = (launcher ?? defaultLauncher)().then((b) => { browser = b; return b; }).finally(() => { opening = null; });
  }
  return opening;
}

function armIdleClose(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { if (inFlight === 0) void closeRenderer(); }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | null = null;
  const guard = new Promise<never>((_, reject) => { t = setTimeout(() => reject(new ClassifiedError("timeout", `${what} exceeded ${ms}ms`)), ms); });
  return Promise.race([p, guard]).finally(() => { if (t) clearTimeout(t); }) as Promise<T>;
}

async function closeQuietly(what: { close(): Promise<void> } | null, label: string): Promise<void> {
  if (!what) return;
  try { await withTimeout(what.close(), HANG_GUARD_MS, `${label}.close`); } catch { /* already gone or wedged — nothing left to hold */ }
}

export async function renderPageHtml(url: string): Promise<{ status: number; html: string }> {
  inFlight += 1;
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  let ctx: RenderContext | null = null;
  let page: RenderPage | null = null;
  try {
    const b = await open();
    ctx = await b.newContext({ userAgent: UA });
    page = await ctx.newPage();
    await page.route("**/*", async (route, request) => {
      const t = request.resourceType();
      if (t === "image" || t === "media" || t === "font") await route.abort();
      else await route.continue();
    });
    const res = await page.goto(url, { waitUntil: "networkidle", timeout: RENDER_TIMEOUT_MS });
    const html = await withTimeout(page.content(), HANG_GUARD_MS, "page.content");
    return { status: res?.status() ?? 0, html };
  } finally {
    await closeQuietly(page, "page");
    await closeQuietly(ctx, "context");
    inFlight -= 1;
    if (browser) armIdleClose();
  }
}

/** Close the shared browser. Idempotent; safe to call from any finally. */
export async function closeRenderer(): Promise<void> {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (opening) { try { await opening; } catch { /* launch failed: nothing to close */ } }
  const b = browser;
  browser = null;
  await closeQuietly(b, "browser");
}

/** Scope the renderer to a block: whatever `fn` does, the browser closes. */
export async function withRenderer<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } finally {
    await closeRenderer();
  }
}
