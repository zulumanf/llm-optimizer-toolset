"use client";
/**
 * Audit engagement beacon (spec 098). Mounted once per audit page render;
 * reports a few high-value behavioral signals against the server-side view
 * row: engaged time (visibility- and activity-aware), scroll milestones
 * (fired once each), section/evidence/CTA interactions (from data-signal-*
 * attributes), all batched through navigator.sendBeacon. Renders nothing,
 * blocks nothing, fails silently. Session/visitor ids are random values in
 * sessionStorage/localStorage — not fingerprints.
 */
import { useEffect } from "react";

const SCROLL_MILESTONES = [25, 50, 75, 90] as const;
/** Engaged-time reports: at these cumulative seconds, then every 60s. */
const ENGAGED_REPORT_SECONDS = [30, 60] as const;
const ENGAGED_REPORT_EVERY_SECONDS = 60;
const TICK_MS = 5_000;
/** No pointer/scroll/key activity for this long = not engaged. */
const IDLE_AFTER_MS = 30_000;
const FLUSH_EVERY_MS = 5_000;
const ENDPOINT = "/api/audit-signal";
const SESSION_KEY = "rf_audit_session";
const VISITOR_KEY = "rf_audit_visitor";

type Kind = "engaged_time" | "scroll" | "section_viewed" | "evidence_expanded" | "cta_clicked";
interface Event {
  kind: Kind;
  value?: number;
  target?: string;
}

function randomId(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "");
  } catch {
    return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
  }
}

function storedId(storage: Storage | null, key: string): string | null {
  try {
    if (!storage) return null;
    const existing = storage.getItem(key);
    if (existing) return existing;
    const id = randomId();
    storage.setItem(key, id);
    return id;
  } catch {
    return null;
  }
}

export function EngagementBeacon({
  viewId,
  /** Evidence key emitted once on mount — the answers page IS evidence
   * being read, so it reports itself without waiting for a drawer. */
  initialEvidence,
}: {
  viewId: string;
  initialEvidence?: string;
}) {
  useEffect(() => {
    if (typeof window === "undefined" || !viewId) return;
    const sessionId =
      storedId(window.sessionStorage ?? null, SESSION_KEY) ?? randomId();
    const visitorId = storedId(window.localStorage ?? null, VISITOR_KEY);

    const queue: Event[] = initialEvidence
      ? [{ kind: "evidence_expanded", target: initialEvidence }]
      : [];
    const fired = new Set<string>();
    const once = (key: string, e: Event) => {
      if (fired.has(key)) return;
      fired.add(key);
      queue.push(e);
    };

    const flush = () => {
      if (queue.length === 0) return;
      const events = queue.splice(0, 20);
      const body = JSON.stringify({ viewId, sessionId, visitorId, events });
      try {
        if (!navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: "application/json" }))) {
          void fetch(ENDPOINT, { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => undefined);
        }
      } catch {
        /* telemetry never surfaces */
      }
    };

    // Engaged time.
    let lastActivity = Date.now();
    let engagedSeconds = 0;
    let nextReportAt: number = ENGAGED_REPORT_SECONDS[0];
    const activity = () => {
      lastActivity = Date.now();
    };
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastActivity > IDLE_AFTER_MS) return;
      engagedSeconds += TICK_MS / 1000;
      if (engagedSeconds >= nextReportAt) {
        queue.push({ kind: "engaged_time", value: Math.round(engagedSeconds) });
        const next = ENGAGED_REPORT_SECONDS.find((s) => s > nextReportAt);
        nextReportAt = next ?? nextReportAt + ENGAGED_REPORT_EVERY_SECONDS;
      }
    };

    // Scroll milestones.
    let scrollTicking = false;
    const onScroll = () => {
      if (scrollTicking) return;
      scrollTicking = true;
      window.requestAnimationFrame(() => {
        scrollTicking = false;
        const doc = document.documentElement;
        const max = doc.scrollHeight - window.innerHeight;
        const pct = max <= 0 ? 100 : Math.round(((window.scrollY + 0.5) / max) * 100);
        for (const m of SCROLL_MILESTONES) if (pct >= m) once(`scroll:${m}`, { kind: "scroll", value: m });
      });
      activity();
    };

    // Sections in view (IntersectionObserver), drawers opened, CTA clicked.
    const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-signal-section]"));
    const observer =
      "IntersectionObserver" in window
        ? new IntersectionObserver(
            (entries) => {
              for (const en of entries) {
                if (!en.isIntersecting) continue;
                const key = (en.target as HTMLElement).dataset.signalSection;
                if (key) once(`section:${key}`, { kind: "section_viewed", target: key });
              }
            },
            { threshold: 0.4 }
          )
        : null;
    sections.forEach((el) => {
      // <details> sections count when opened, not when scrolled past.
      if (el.tagName !== "DETAILS") observer?.observe(el);
    });
    const onToggle = (ev: globalThis.Event) => {
      const el = ev.target as HTMLElement | null;
      if (!(el instanceof HTMLDetailsElement) || !el.open) return;
      if (el.dataset.signalEvidence) once(`evidence:${el.dataset.signalEvidence}`, { kind: "evidence_expanded", target: el.dataset.signalEvidence });
      if (el.dataset.signalSection) once(`section:${el.dataset.signalSection}`, { kind: "section_viewed", target: el.dataset.signalSection });
      activity();
    };
    const onClick = (ev: MouseEvent) => {
      const cta = (ev.target as HTMLElement | null)?.closest<HTMLElement>("[data-signal-cta]");
      if (cta) {
        once(`cta:${cta.dataset.signalCta}`, { kind: "cta_clicked", target: cta.dataset.signalCta || "cta" });
        flush();
      }
      activity();
    };
    const onHide = () => {
      if (engagedSeconds >= 10) queue.push({ kind: "engaged_time", value: Math.round(engagedSeconds) });
      flush();
    };

    const tickTimer = window.setInterval(tick, TICK_MS);
    const flushTimer = window.setInterval(flush, FLUSH_EVERY_MS);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pointerdown", activity, { passive: true });
    window.addEventListener("keydown", activity, { passive: true });
    window.addEventListener("pointermove", activity, { passive: true });
    document.addEventListener("toggle", onToggle, true);
    document.addEventListener("click", onClick, true);
    window.addEventListener("pagehide", onHide);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    document.addEventListener("visibilitychange", onVisibility);
    onScroll();
    flush();

    return () => {
      window.clearInterval(tickTimer);
      window.clearInterval(flushTimer);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      window.removeEventListener("pointermove", activity);
      document.removeEventListener("toggle", onToggle, true);
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      observer?.disconnect();
    };
  }, [viewId, initialEvidence]);
  return null;
}
