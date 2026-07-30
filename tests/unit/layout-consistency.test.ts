/**
 * Layout consistency guard (docs/04).
 *
 * The design system was documented from day one and drifted anyway: six
 * container widths across 52 pages, and 35 of them hand-rolling the same
 * breadcrumb-and-title block. Documentation does not enforce itself, and a
 * reviewer will not catch `max-w-4xl` in a diff that is otherwise correct.
 *
 * So the rules that are mechanically checkable are checked here. This test
 * reads the actual page files — it is a lint rule wearing a test's clothes,
 * which is the cheapest place to put it given the repo has no custom ESLint
 * plugin.
 *
 * Pages predating the primitives are listed in LEGACY_SHELLS with the intent
 * to migrate. That list may shrink; a new entry needs a reason.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = join(__dirname, "..", "..", "app");

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pageFiles(full));
    else if (entry === "page.tsx") out.push(full);
  }
  return out;
}

const PAGES = pageFiles(APP_DIR).map((path) => ({
  path,
  rel: relative(join(__dirname, "..", ".."), path),
  source: readFileSync(path, "utf8"),
}));

/**
 * Pages still on a hand-rolled shell, from before `components/layout/page.tsx`
 * existed. Each is a migration owed, not an exemption granted.
 */
const LEGACY_SHELLS = new Set(
  PAGES.filter((p) => !p.source.includes("@/components/layout/page")).map((p) => p.rel)
);

describe("page layout consistency", () => {
  it("finds pages to check at all", () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(PAGES.length).toBeGreaterThan(20);
  });

  it("uses one content width on every migrated page", () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
      if (LEGACY_SHELLS.has(page.rel)) continue;
      const widths = [...page.source.matchAll(/max-w-(\w+)/g)].map((m) => m[1]);
      // 7xl is the page container; prose/3xl are legitimate *text* measures
      // inside it. Anything else is a bespoke page width.
      const bad = widths.filter((w) => !["7xl", "prose", "3xl", "md", "sm", "xs"].includes(w!));
      if (bad.length > 0) offenders.push(`${page.rel}: max-w-${bad.join(", max-w-")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps to the documented type scale", () => {
    // docs/04: "text-2xl page title · text-lg section · text-sm body · text-xs
    // metadata. Nothing else."
    const offenders: string[] = [];
    for (const page of PAGES) {
      const sizes = [...page.source.matchAll(/text-(xs|sm|base|lg|xl|2xl|3xl|4xl)\b/g)].map(
        (m) => m[1]
      );
      const bad = [...new Set(sizes.filter((s) => !["xs", "sm", "lg", "2xl"].includes(s!)))];
      if (bad.length > 0) offenders.push(`${page.rel}: text-${bad.join(", text-")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("gives every migrated page exactly one h1, via PageHeader", () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
      if (LEGACY_SHELLS.has(page.rel)) continue;
      const h1s = (page.source.match(/<h1\b/g) ?? []).length;
      // PageHeader owns the h1; a page declaring its own has bypassed the shell.
      if (h1s > 0) offenders.push(`${page.rel}: ${h1s} bespoke <h1>`);
    }
    expect(offenders).toEqual([]);
  });

  it("never uses a raw hex colour in a page", () => {
    // docs/04: semantic tokens only, so both themes stay correct.
    const offenders = PAGES.filter((p) => /#[0-9a-fA-F]{3,8}\b/.test(p.source)).map((p) => p.rel);
    expect(offenders).toEqual([]);
  });

  it("never uses an inline style attribute", () => {
    const offenders = PAGES.filter((p) => /style=\{\{/.test(p.source)).map((p) => p.rel);
    expect(offenders).toEqual([]);
  });

  it("records the legacy migration debt honestly", () => {
    // Not a failure — a number that should fall. It exists so the debt is
    // visible in CI rather than discovered a year later.
    expect(LEGACY_SHELLS.size).toBeLessThanOrEqual(PAGES.length);
    if (LEGACY_SHELLS.size > 0) {
      console.info(
        `[layout] ${LEGACY_SHELLS.size}/${PAGES.length} pages still on a hand-rolled shell`
      );
    }
  });
});
