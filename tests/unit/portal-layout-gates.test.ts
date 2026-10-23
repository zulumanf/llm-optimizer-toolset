/**
 * Spec 155 regression: Next.js renders nested layouts in parallel, so a
 * parent layout's notFound() does not stop a child layout from streaming
 * project data. Every layout under the portal's [projectId] segment must
 * gate itself. (Found by rendering an ungranted project as a client: the
 * dashboard layout streamed the other client's project name.)
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const PORTAL = join(ROOT, "app", "portal", "[projectId]");

function layouts(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return layouts(full);
    return name === "layout.tsx" ? [full] : [];
  });
}

describe("portal layouts gate themselves", () => {
  it("every [projectId] layout calls requirePortalPage", () => {
    const found = layouts(PORTAL);
    expect(found.length).toBeGreaterThanOrEqual(2);
    const ungated = found.filter((f) => !/requirePortalPage\(/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
    expect(ungated).toEqual([]);
  });
});
