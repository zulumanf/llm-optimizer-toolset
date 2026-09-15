/**
 * NO_PARSE_DOWNGRADE (pipeline hardening 2026-09-14): the authoritative
 * revision of a (response, company) pair is class-first — a heuristic row
 * appended during a provider outage never supersedes a classifier or human
 * judgment — and the SQL mirror in db/mentions.ts states the same rule.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authoritativeRevision, isClassifierClass } from "@/lib/parsing/precedence";
import { PARSER_VERSION_ADJUDICATION, PARSER_VERSION_HEURISTIC, PARSER_VERSION_LLM } from "@/lib/constants";

const row = (revision: number, parserVersion: string, reviewed = false) => ({ revision, parserVersion, reviewed });

describe("authoritativeRevision", () => {
  it("newer heuristic row does not demote an LLM judgment (the incident)", () => {
    const r = authoritativeRevision([row(1, PARSER_VERSION_LLM), row(2, PARSER_VERSION_HEURISTIC)]);
    expect(r?.revision).toBe(1);
  });
  it("newer LLM row supersedes an older LLM row", () => {
    expect(authoritativeRevision([row(1, PARSER_VERSION_LLM), row(2, PARSER_VERSION_LLM)])?.revision).toBe(2);
  });
  it("heuristic-only pairs keep the newest heuristic row (no classifier ever ran)", () => {
    expect(authoritativeRevision([row(1, PARSER_VERSION_HEURISTIC), row(2, PARSER_VERSION_HEURISTIC)])?.revision).toBe(2);
  });
  it("an LLM upgrade of a heuristic-only pair wins whatever its revision number", () => {
    expect(authoritativeRevision([row(1, PARSER_VERSION_HEURISTIC), row(2, PARSER_VERSION_LLM)])?.revision).toBe(2);
    expect(authoritativeRevision([row(3, PARSER_VERSION_HEURISTIC), row(2, PARSER_VERSION_LLM)])?.revision).toBe(2);
  });
  it("adjudication and human-reviewed rows are classifier-class", () => {
    expect(isClassifierClass(row(1, PARSER_VERSION_ADJUDICATION))).toBe(true);
    expect(isClassifierClass(row(1, PARSER_VERSION_HEURISTIC, true))).toBe(true);
    expect(isClassifierClass(row(1, PARSER_VERSION_HEURISTIC))).toBe(false);
    expect(authoritativeRevision([row(1, PARSER_VERSION_LLM), row(2, PARSER_VERSION_HEURISTIC, true)])?.revision).toBe(2);
  });
  it("is deterministic regardless of input order and returns null for no rows", () => {
    const rows = [row(2, PARSER_VERSION_HEURISTIC), row(1, PARSER_VERSION_LLM), row(3, PARSER_VERSION_HEURISTIC)];
    expect(authoritativeRevision(rows)?.revision).toBe(1);
    expect(authoritativeRevision([...rows].reverse())?.revision).toBe(1);
    expect(authoritativeRevision([])).toBeNull();
  });
});

describe("SQL mirror and shadow mirror carry the same rule", () => {
  it("db/mentions.ts CURRENT_REVISION ranks class before revision", () => {
    const src = readFileSync("db/mentions.ts", "utf8");
    const frag = src.slice(src.indexOf("export const CURRENT_REVISION"), src.indexOf("const CURRENT = CURRENT_REVISION"));
    expect(frag).toMatch(/newer\.reviewed_by is not null/);
    expect(frag).toMatch(/PARSER_VERSION_LLM/);
    expect(frag).toMatch(/PARSER_VERSION_ADJUDICATION/);
    expect(frag).toMatch(/newer\.revision > m\.revision/);
  });
  it("evidence-release shadow re-derives the class rule without importing the SQL", () => {
    const src = readFileSync("lib/prospects/evidence-release.ts", "utf8");
    expect(src).toMatch(/function classifierClass\(m: ShadowMention\)/);
    expect(src).not.toMatch(/CURRENT_REVISION/);
    expect(src).not.toMatch(/authoritativeRevision/);
  });
});
