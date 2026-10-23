/**
 * Release 151 cutover guard. During the cutover window every run carries
 * BOTH v1.1 and v1.2 rows in `scores`. A value read that does not pin the
 * version (normally `READ_SCORING_VERSION`, the scoring_state switch) would
 * silently double-count or mix versions. This scans every query touching
 * `scores` in app code and fails unless, within the same statement window,
 * it pins `scoring_version`, or it is a pure existence/count/id lookup.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = ["lib", "db", "app", "components"];
const SKIP_DIRS = new Set(["migrations"]);
const OCCURRENCE = /\b(from|join)\s+scores\b/g;
/** Reads that are version-agnostic by construction. */
const EXEMPT = [
  /exists\s*\(\s*select 1 from scores/i,
  /select 1 from scores/i,
  /count\(\*\)::int from scores where run_id/i,
  /from scores\s+where id = any/i, // lookup by immutable row id
  /select distinct c\.id, c\.name from scores/i, // names only
  /insert into scores/i,
];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return SKIP_DIRS.has(name) ? [] : files(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

describe("scores readers pin the scoring version (release 151)", () => {
  it("every value read of `scores` filters on scoring_version", () => {
    const offenders: string[] = [];
    for (const file of ROOTS.flatMap(files)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(OCCURRENCE)) {
        const at = m.index ?? 0;
        const before = text.slice(Math.max(0, at - 120), at + 40);
        const window = text.slice(Math.max(0, at - 400), at + 700);
        // The statement ends at the template literal's closing backtick.
        const end = text.indexOf("`", at);
        const statement = text.slice(Math.max(0, text.lastIndexOf("`", at)), end === -1 ? at + 700 : end);
        if (EXEMPT.some((re) => re.test(before))) continue;
        if (/scoring_version/.test(statement) || /READ_SCORING_VERSION/.test(statement)) continue;
        if (/latest\.scoringVersion|args\.scoringVersion/.test(window)) continue;
        const line = text.slice(0, at).split("\n").length;
        offenders.push(`${file}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
