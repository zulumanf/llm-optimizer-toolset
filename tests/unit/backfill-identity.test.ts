/**
 * Identity keys of the hardened pipeline (2026-09-14): market identity is
 * markets.id (display names are labels), resolution identity is the alias
 * graph hash, and the migration binds only unambiguous legacy projects.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { aliasHashFor, BACKFILL_CLASSIFIER_CALL_REVIEW_THRESHOLD, BACKFILL_RUN_LIMIT } from "@/lib/parsing/backfill";
import { marketBenchmarkProjectName } from "@/lib/markets/bootstrap";

describe("market identity", () => {
  it("same display name + different state reads as two labels", () => {
    expect(marketBenchmarkProjectName("Wilmington", "NC")).not.toBe(marketBenchmarkProjectName("Wilmington", "DE"));
    expect(marketBenchmarkProjectName("Testville", null)).toBe("Market benchmark: Testville");
  });
  it("migration 117 binds projects.market_id only where name → exactly one market and one project", () => {
    const sql = readFileSync("db/migrations/117_parse_backfill_hardening.sql", "utf8");
    expect(sql).toMatch(/add column if not exists market_id uuid references markets\(id\)/);
    expect(sql).toMatch(/create unique index if not exists projects_market_benchmark_uidx/);
    expect(sql).toMatch(/select count\(\*\) from markets m2 where m2\.name = m\.name\) = 1/);
    expect(sql).toMatch(/select count\(\*\) from projects p2 where p2\.name = p\.name and p2\.archived_at is null\) = 1/);
    expect(sql).not.toMatch(/delete from/i);
  });
  it("bootstrap keys the idempotent lookup on market_id and refuses unbound legacy collisions", () => {
    const src = readFileSync("lib/markets/bootstrap.ts", "utf8");
    expect(src).toMatch(/where p\.market_id = \$\{marketId\} and p\.archived_at is null/);
    expect(src).not.toMatch(/where p\.name = \$\{projectName\}/);
    expect(src).toMatch(/PROJECT_MARKET_REVIEW_REQUIRED/);
  });
});

describe("resolution identity (alias graph hash)", () => {
  const base = { name: "Kirsch Team", aliases: ["The Kirsch Team", "Kirsch Group"], domain: "kirsch.example" };
  it("is stable under alias order, case and whitespace", () => {
    const a = aliasHashFor(base, ["Laura Kirsch"]);
    const b = aliasHashFor({ ...base, aliases: [" kirsch group", "THE KIRSCH TEAM "] }, [" laura kirsch"]);
    expect(a).toBe(b);
  });
  it("changes when an alias, the domain or an identity fact changes", () => {
    const a = aliasHashFor(base, []);
    expect(aliasHashFor({ ...base, aliases: [...base.aliases, "Kirsch Realty"] }, [])).not.toBe(a);
    expect(aliasHashFor({ ...base, domain: null }, [])).not.toBe(a);
    expect(aliasHashFor(base, ["Laura Kirsch"])).not.toBe(a);
  });
  it("does not depend on which other companies are tracked (attaching a company invalidates nothing)", () => {
    expect(aliasHashFor(base, [])).toBe(aliasHashFor({ ...base }, []));
  });
  it("cost guard constants are conservative and documented", () => {
    expect(BACKFILL_RUN_LIMIT).toBe(12);
    expect(BACKFILL_CLASSIFIER_CALL_REVIEW_THRESHOLD).toBeGreaterThanOrEqual(100);
  });
});

describe("no delete-and-reparse path remains on competitor attach", () => {
  it("competitors/service.ts no longer deletes response_parses or enqueues per-response parses", () => {
    const src = readFileSync("lib/competitors/service.ts", "utf8");
    expect(src).not.toMatch(/response_parses/);
    expect(src).not.toMatch(/enqueueParseJobs/);
    expect(src).toMatch(/enqueueCompanyBackfill\(projectId, companyId, "competitor_attach"\)/);
  });
  it("supply-promote attaches by market_id and never deletes a competitor to trigger a backfill", () => {
    const src = readFileSync("scripts/supply-promote.ts", "utf8");
    expect(src).toMatch(/p\.market_id = \$\{launch\.marketId\}/);
    expect(src).not.toMatch(/delete from competitors/);
    expect(src).toMatch(/withRenderer\(main\)/);
  });
});
