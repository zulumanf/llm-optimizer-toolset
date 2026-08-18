/**
 * Source-type playbooks (spec 087): every taxonomy value has legitimate
 * recommended actions and a valid default acquisition path, and no playbook
 * smuggles a prohibited tactic in any phrasing.
 */
import { describe, it, expect } from "vitest";
import {
  allPlaybooks,
  playbookFor,
  PROHIBITED_TACTICS,
  SOURCE_PLAYBOOK_VERSION,
} from "@/lib/sources/playbooks";
import { ACQUISITION_PATHS } from "@/lib/citations/constants";

/** Word stems that would indicate a prohibited tactic under any phrasing. */
const PROHIBITED_STEMS = [
  /fake/i,
  /persona/i,
  /astroturf/i,
  /undisclosed/i,
  /\bspam/i,
  /manufactur/i,
  /fabricat/i,
  /buy.*(link|review)/i,
  /purchas.*(link|review)/i,
];

const SOURCE_TYPES = [
  "client_site",
  "brokerage",
  "portal",
  "news",
  "directory",
  "social",
  "video",
  "review",
  "government",
  "industry_ranking",
  "local_press",
  "other",
] as const;

describe("source playbooks", () => {
  it("covers every source type in the taxonomy with at least one action", () => {
    expect(SOURCE_PLAYBOOK_VERSION).toBe("source-playbook-v1");
    for (const type of SOURCE_TYPES) {
      const playbook = playbookFor(type);
      expect(playbook, type).toBeDefined();
      expect(playbook!.actions.length, type).toBeGreaterThanOrEqual(1);
      expect(playbook!.label.length, type).toBeGreaterThan(0);
    }
    expect(allPlaybooks()).toHaveLength(SOURCE_TYPES.length);
  });

  it("default acquisition paths come from the existing enum", () => {
    for (const playbook of allPlaybooks()) {
      expect(ACQUISITION_PATHS).toContain(playbook.defaultAcquisitionPath);
    }
  });

  it("no playbook action contains a prohibited tactic", () => {
    expect(PROHIBITED_TACTICS.length).toBeGreaterThan(0);
    for (const playbook of allPlaybooks()) {
      for (const action of playbook.actions) {
        for (const stem of PROHIBITED_STEMS) {
          expect(action, `${playbook.sourceType}: "${action}"`).not.toMatch(stem);
        }
      }
    }
  });

  it("owned surfaces are distinguishable from independent authority", () => {
    expect(playbookFor("client_site")!.owned).toBe(true);
    expect(playbookFor("brokerage")!.owned).toBe(true);
    expect(playbookFor("local_press")!.owned).toBe(false);
    expect(playbookFor("industry_ranking")!.owned).toBe(false);
  });

  it("unknown source types return undefined — callers skip, never guess", () => {
    expect(playbookFor("blog_network")).toBeUndefined();
  });
});
