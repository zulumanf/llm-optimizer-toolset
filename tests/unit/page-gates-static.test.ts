/**
 * Spec 156: every internal page gates ITSELF, as its first statement.
 *
 * Next.js renders a route's layouts and page concurrently. A layout's
 * redirect()/notFound() does not stop the page from rendering, and the page's
 * data is streamed in the response — a client account read other clients'
 * projects through /projects/<id>/* and /work while the browser showed a 404.
 * Layout gates are defence in depth only.
 *
 * "First statement" is the rule because it is checkable: nothing can be read
 * before the gate if nothing runs before it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

/** Pages with no staff gate, each for a stated reason. */
const EXEMPT: { pattern: RegExp; reason: string }[] = [
  { pattern: /^app\/\(marketing\)\//, reason: "public marketing site" },
  { pattern: /^app\/login\/page\.tsx$/, reason: "sign-in screen" },
  { pattern: /^app\/report\/\[slug\]\//, reason: "prospect report, gated by its own report session (spec 134)" },
  { pattern: /^app\/unsubscribe\/\[token\]\/page\.tsx$/, reason: "prospect one-click unsubscribe; the token is the credential and answers are uniform (spec 157)" },
  { pattern: /^app\/portal\//, reason: "client portal; every read goes through lib/portal/service.ts, which asserts project access per call" },
];

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return pages(full);
    return name === "page.tsx" ? [full] : [];
  });
}

/** The first statement of the default-exported page function, or null. */
function firstStatement(src: string): string | null {
  const m = /export default async function \w+\s*\(/.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length - 1;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) break;
  }
  const open = src.indexOf("{", i);
  const body = src.slice(open + 1).replace(/^\s*(\/\/[^\n]*\n\s*)*/, "");
  return body.split(";")[0]!.trim();
}

const all = pages(join(ROOT, "app")).map((f) => relative(ROOT, f).split(sep).join("/"));
const internal = all.filter((rel) => !EXEMPT.some((e) => e.pattern.test(rel)));

describe("page-level authorization (spec 156)", () => {
  it("finds the pages (sanity)", () => {
    expect(all.length).toBeGreaterThan(50);
    expect(internal.length).toBeGreaterThan(40);
  });

  it("every internal page awaits its gate as its first statement", () => {
    const offenders = internal.filter((rel) => {
      const first = firstStatement(readFileSync(join(ROOT, rel), "utf8"));
      const project = rel.startsWith("app/projects/[id]/");
      return project
        ? !(first && /^await requireProjectStaffPage\(\(await params\)\.id\)$/.test(first))
        : !(first && /^await requireStaffPage\(\)/.test(first));
    });
    expect(offenders).toEqual([]);
  });

  it("the checker rejects a page that reads before gating", () => {
    const leaky = `export default async function P({ params }: { params: Promise<{ id: string }> }) {
  const data = await load();
  await requireProjectStaffPage((await params).id);
  return null;
}`;
    expect(firstStatement(leaky)).toBe("const data = await load()");
  });
});
