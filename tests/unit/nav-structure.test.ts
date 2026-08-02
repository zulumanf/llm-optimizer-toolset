/**
 * Spec 037 — the nav config is a covering, not a suggestion: every project
 * section is reachable from the sidebar either as its own entry or as a
 * tab sibling of one; nothing is orphaned, nothing is listed twice.
 */
import { describe, expect, it } from "vitest";
import {
  PROJECT_NAV_GROUPS,
  PROJECT_SECTIONS,
  TAB_SETS,
  sectionFor,
  tabSetFor,
} from "@/components/layout/sections";

describe("nav structure (spec 037)", () => {
  it("every sidebar entry names a real section", () => {
    for (const group of PROJECT_NAV_GROUPS) {
      for (const path of group.paths) {
        expect(sectionFor(path), `sidebar entry ${path || "(dashboard)"}`).toBeDefined();
      }
    }
  });

  it("every tab-set member is a real section, and lead paths are sidebar entries", () => {
    const sidebarPaths = new Set(PROJECT_NAV_GROUPS.flatMap((g) => g.paths));
    for (const set of TAB_SETS) {
      expect(set.paths.length).toBeGreaterThan(1);
      for (const path of set.paths) {
        expect(sectionFor(path), `tab member ${path}`).toBeDefined();
      }
      expect(
        sidebarPaths.has(set.paths[0]!),
        `tab set ${set.key} lead ${set.paths[0]} must be a sidebar entry`
      ).toBe(true);
    }
  });

  it("covers all sections exactly once — no orphans, no duplicates", () => {
    const reachable: string[] = [];
    for (const group of PROJECT_NAV_GROUPS) {
      for (const path of group.paths) {
        const set = tabSetFor(path);
        reachable.push(...(set ? set.paths : [path]));
      }
    }
    const expected = PROJECT_SECTIONS.map((s) => s.path).sort();
    expect([...reachable].sort()).toEqual(expected);
    expect(new Set(reachable).size).toBe(reachable.length);
  });

  it("a section belongs to at most one tab set", () => {
    const seen = new Map<string, string>();
    for (const set of TAB_SETS) {
      for (const path of set.paths) {
        expect(seen.has(path), `${path} in ${seen.get(path)} and ${set.key}`).toBe(false);
        seen.set(path, set.key);
      }
    }
  });
});
