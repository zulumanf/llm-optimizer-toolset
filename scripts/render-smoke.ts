/**
 * Process-exit regression for the headless renderer (hardening 2026-09-14).
 *
 * Renders a data: page through the real Playwright Chromium the way rendered
 * contact verification does, then checks that (1) `withRenderer` left no live
 * browser handle, (2) no Chromium child of THIS process survives, and (3) the
 * Node process exits on its own — the observed leak kept a finished 26-second
 * promotion alive for ~14 minutes. No fixed millisecond threshold: the check
 * is "the event loop drained", asserted by reaching the exit handler at all,
 * with a generous watchdog only to turn a hang into a visible failure.
 *
 *   npx tsx scripts/render-smoke.ts
 *
 * Exit 0 = BROWSER_RESOURCES_CLOSED PASS. Any other exit = BLOCK.
 */
import { execFileSync } from "node:child_process";
import { renderPageHtml, rendererIsOpen, withRenderer } from "@/lib/prospects/contact-render";

const WATCHDOG_MS = 60_000;

function chromiumChildrenOf(pid: number): string[] {
  try {
    const out = execFileSync("ps", ["-eo", "pid=,ppid=,comm="], { encoding: "utf8" });
    const rows = out.split("\n").map((l) => l.trim().split(/\s+/, 3)).filter((r) => r.length === 3);
    const children = new Set<number>([pid]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [p, pp] of rows) {
        if (children.has(Number(pp)) && !children.has(Number(p))) { children.add(Number(p)); grew = true; }
      }
    }
    return rows.filter(([p, , comm]) => children.has(Number(p)) && Number(p) !== pid && /chrom/i.test(comm ?? "")).map((r) => r.join(" "));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  const page = "data:text/html,<html><body><p>Contact: <a href='mailto:agent@example.test'>agent@example.test</a></p></body></html>";
  const rendered = await withRenderer(async () => {
    const ok = await renderPageHtml(page);
    let failurePathClosed = false;
    try {
      await renderPageHtml("http://127.0.0.1:9/unreachable"); // navigation throws
    } catch {
      failurePathClosed = true;
    }
    return { htmlHasEmail: ok.html.includes("agent@example.test"), failurePathClosed };
  });
  const open = rendererIsOpen();
  const children = chromiumChildrenOf(process.pid);
  const verdict = rendered.htmlHasEmail && rendered.failurePathClosed && !open && children.length === 0;
  console.log(JSON.stringify({ invariant: "BROWSER_RESOURCES_CLOSED", verdict: verdict ? "PASS" : "BLOCK", rendered, rendererOpen: open, chromiumChildren: children }, null, 1));
  if (!verdict) process.exitCode = 2;
}

const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ invariant: "BROWSER_RESOURCES_CLOSED", verdict: "BLOCK", reason: `process still alive ${WATCHDOG_MS}ms after work finished — a browser or timer is holding the event loop` }));
  process.exit(3);
}, WATCHDOG_MS);
watchdog.unref();

process.on("exit", (code) => { if (code === 0) console.log("process exited on its own: PASS"); });
main().catch((e) => { console.error(e); process.exitCode = 1; });
