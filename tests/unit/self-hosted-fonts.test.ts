/**
 * Builds must not download fonts. `next/font/google` fetches font files from
 * Google at build time; on GitHub's runners Google returned a URL the Next.js
 * loader cannot parse, failing every CI build. Fonts are self-hosted in
 * components/fonts (one definition, imported everywhere).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");
const FONT_DIR = join(ROOT, "components", "fonts");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name === "node_modules" || name.startsWith(".")) return [];
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe("self-hosted fonts", () => {
  it("no source file imports next/font/google", () => {
    const offenders = ["app", "components", "lib"]
      .flatMap((d) => sources(join(ROOT, d)))
      .filter((f) => /from\s+["']next\/font\/google["']/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("every font file the module references exists, is WOFF2, and ships with its licence", () => {
    const src = readFileSync(join(FONT_DIR, "index.ts"), "utf8");
    const files = [...src.matchAll(/["']\.\/([\w.-]+\.woff2)["']/g)].map((m) => m[1]!);
    expect(files.length).toBe(4);
    for (const f of files) {
      const bytes = readFileSync(join(FONT_DIR, f));
      expect(bytes.subarray(0, 4).toString("latin1"), f).toBe("wOF2");
    }
    for (const family of ["Inter", "JetBrains-Mono", "Newsreader"]) {
      const licence = join(FONT_DIR, `OFL-${family}.txt`);
      expect(existsSync(licence), licence).toBe(true);
      expect(readFileSync(licence, "utf8")).toMatch(/SIL OPEN FONT LICENSE/);
    }
  });
});
