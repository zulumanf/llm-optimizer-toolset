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
import { findProhibitedPhrase } from "../../lib/prospects/constants";

const APP_DIR = join(__dirname, "..", "..", "app");
const COMPONENTS_DIR = join(__dirname, "..", "..", "components");

/**
 * The public marketing site (spec 061) is a declared surface class, not
 * workspace debt: it carries its own chrome and layout, so the workspace
 * shell/h1/width rules don't apply, and it gets one extra display size
 * (text-4xl) for the hero. Hex and inline-style bans still apply, and its
 * copy is guarded by the prohibited-phrases rule below.
 */
const isMarketingSurface = (rel: string): boolean =>
  rel.startsWith("app/(marketing)/") || rel.startsWith("components/marketing/");

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...pageFiles(full));
    else if (entry === "page.tsx") out.push(full);
  }
  return out;
}

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsxFiles(full));
    else if (entry.endsWith(".tsx")) out.push(full);
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
 *
 * FROZEN LITERAL LIST (cleanup audit 2026-08-04). The previous version
 * computed this set as "every page that doesn't import the primitives" —
 * which meant not importing them WAS the exemption, every new page shipped
 * unguarded by default, and width drift measurably widened after the guard
 * landed (6 widths → 10). The list below is the debt as of the freeze; it
 * may only shrink. A new page must use the shell or fail this suite.
 */
/**
 * Deliberate exemptions, NOT debt (split from the ratchet 2026-08-17):
 * these pages' hand-rolled shells ARE the design and must never migrate.
 */
const INTENTIONAL_SHELLS = new Map<string, string>([
  ["app/report/[slug]/page.tsx", "private report behind the clean URL (spec 134) — renders the document page"],
  ["app/report/[slug]/answers/page.tsx", "private report appendix (spec 134) — renders the appendix"],
  ["app/report/[slug]/walkthrough/page.tsx", "private report scheduling page (spec 134) — renders the scheduling page"],
  ["app/portal/page.tsx", "client portal landing — the portal carries its own shell (spec 031)"],
  ["app/portal/[projectId]/page.tsx", "client portal overview — portal shell (specs 031/085)"],
  ["app/portal/[projectId]/work/page.tsx", "client portal — portal shell"],
  ["app/portal/[projectId]/reports/page.tsx", "client portal — portal shell"],
  ["app/login/page.tsx", "auth screen — renders before any workspace exists"],
]);

const LEGACY_SHELLS = new Set<string>([]);

// The ratchet: a page that migrates must leave the list, and a page not on
// the list must use the shell. Both directions fail loudly.
describe("legacy-shell ratchet", () => {
  it("every non-legacy page uses the layout primitives", () => {
    const offenders = PAGES.filter(
<<<<<<< HEAD
      (p) =>
        !LEGACY_SHELLS.has(p.rel) &&
        !isMarketingSurface(p.rel) &&
        !p.source.includes("@/components/layout/page")
=======
      (p) => !LEGACY_SHELLS.has(p.rel) && !INTENTIONAL_SHELLS.has(p.rel) && !p.source.includes("@/components/layout/page")
>>>>>>> origin/main
    ).map((p) => p.rel);
    expect(offenders).toEqual([]);
  });

  it("the list only shrinks — migrated pages must be removed from it", () => {
    const stale = [...LEGACY_SHELLS].filter((rel) => {
      const page = PAGES.find((p) => p.rel === rel);
      return !page || page.source.includes("@/components/layout/page");
    });
    expect(stale).toEqual([]);
  });
});

describe("page layout consistency", () => {
  it("finds pages to check at all", () => {
    // A guard that silently checks nothing is worse than no guard.
    expect(PAGES.length).toBeGreaterThan(20);
  });

  it("uses one content width on every migrated page", () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
<<<<<<< HEAD
      if (LEGACY_SHELLS.has(page.rel) || isMarketingSurface(page.rel)) continue;
=======
      if (LEGACY_SHELLS.has(page.rel) || INTENTIONAL_SHELLS.has(page.rel)) continue;
>>>>>>> origin/main
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
    //
    // Scoped exemption (spec 123 round 2): prospect-facing audit documents
    // under app/audit/ follow audit-page-design, not the workspace scale —
    // the hero metric is a display numeral and may render genuinely large.
    // app/report/ (spec 134) is the same document behind the clean URL.
    // The workspace rule stays intact everywhere else.
    const offenders: string[] = [];
    for (const page of PAGES) {
      if (page.rel.startsWith("app/audit/") || page.rel.startsWith("app/report/")) continue;
      const sizes = [...page.source.matchAll(/text-(xs|sm|base|lg|xl|2xl|3xl|4xl)\b/g)].map(
        (m) => m[1]
      );
      // Marketing pages get one display size on top of the workspace scale.
      const allowed = isMarketingSurface(page.rel)
        ? ["xs", "sm", "lg", "2xl", "4xl"]
        : ["xs", "sm", "lg", "2xl"];
      const bad = [...new Set(sizes.filter((s) => !allowed.includes(s!)))];
      if (bad.length > 0) offenders.push(`${page.rel}: text-${bad.join(", text-")}`);
    }
    expect(offenders).toEqual([]);
  });

  it("gives every migrated page exactly one h1, via PageHeader", () => {
    const offenders: string[] = [];
    for (const page of PAGES) {
<<<<<<< HEAD
      if (LEGACY_SHELLS.has(page.rel) || isMarketingSurface(page.rel)) continue;
=======
      if (LEGACY_SHELLS.has(page.rel) || INTENTIONAL_SHELLS.has(page.rel)) continue;
>>>>>>> origin/main
      const h1s = (page.source.match(/<h1\b/g) ?? []).length;
      // PageHeader owns the h1; a page declaring its own has bypassed the shell.
      if (h1s > 0) offenders.push(`${page.rel}: ${h1s} bespoke <h1>`);
    }
    expect(offenders).toEqual([]);
  });

  // Hex and inline-style rules apply to EVERYTHING that renders, not only
  // pages — the chart components shipped hardcoded dark-theme hex values
  // under a green suite because only page.tsx was scanned (cleanup audit
  // 2026-08-04). global-error.tsx is the one sanctioned exception: it
  // renders outside the Tailwind-bearing root layout by design.
  const RENDERED = [
    ...PAGES,
    ...[...tsxFiles(COMPONENTS_DIR), ...pageFiles(APP_DIR).map((p) => p)]
      .filter((p, i, arr) => arr.indexOf(p) === i)
      .filter((p) => !PAGES.some((page) => page.path === p))
      .map((path) => ({
        path,
        rel: relative(join(__dirname, "..", ".."), path),
        source: readFileSync(path, "utf8"),
      })),
  ].filter((p) => !p.rel.endsWith("global-error.tsx"));

  it("never uses a raw hex colour in anything that renders", () => {
    // docs/04: semantic tokens only, so both themes stay correct.
    const offenders = RENDERED.filter((p) => /#[0-9a-fA-F]{3,8}\b/.test(p.source)).map(
      (p) => p.rel
    );
    expect(offenders).toEqual([]);
  });

  it("never uses an inline style attribute in anything that renders", () => {
    const offenders = RENDERED.filter((p) => /style=\{\{/.test(p.source)).map((p) => p.rel);
    expect(offenders).toEqual([]);
  });

  it("keeps prohibited phrases out of marketing copy (spec 061)", () => {
    // The outreach approval gate runs findProhibitedPhrase on drafts; the
    // marketing site is the same voice with no gate, so the gate lives here.
    const offenders: string[] = [];
    for (const file of RENDERED) {
      if (!isMarketingSurface(file.rel)) continue;
      const phrase = findProhibitedPhrase(file.source);
      if (phrase) offenders.push(`${file.rel}: "${phrase}"`);
    }
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
