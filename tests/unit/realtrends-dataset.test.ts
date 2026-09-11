import { describe, expect, it } from "vitest";
import {
  classifyDatasetMatch,
  normalizeSides,
  normalizeVolume,
  parseSheet,
  periodFromHeader,
  rowFingerprint,
  stateCode,
  type MatchCandidateCompany,
  type ParsedSheetJson,
} from "@/lib/prospects/realtrends-dataset";

// Synthetic fixtures only — never rows from the licensed workbook.

const TEAMS_HEADER = [
  "Team Name",
  "Team Lead First Name",
  "Team Size",
  "Number of Licensed Agents on Team",
  "Company",
  "Network Affiliation",
  "City",
  "State",
  "2025 Sides (2026 Rankings)",
  "2025 Volume (2026 Rankings",
];
const AGENTS_HEADER = [
  "First Name",
  "LastName",
  "Company",
  "City",
  "State",
  "NetworkAffiliation",
  "2025 Sides (2026 Rankings)",
  "2025 Volume (2026 Rankings)",
];

const teamsSheet = (rows: unknown[][]): ParsedSheetJson => ({
  sheet: "Teams",
  header: TEAMS_HEADER,
  rows: rows.map((values, i) => ({ row: i + 2, values })),
});
const TEAM_ROW = [
  "Harbor View Group",
  "Dana",
  "Small",
  4,
  "Compass",
  "Compass",
  "Jersey City",
  "NJ",
  33,
  29_400_000,
];

describe("numeric normalization", () => {
  it("volume accepts numbers, currency strings, and M-suffix", () => {
    expect(normalizeVolume(47_200_000)).toBe(47_200_000);
    expect(normalizeVolume("$47,200,000")).toBe(47_200_000);
    expect(normalizeVolume("47.2M")).toBe(47_200_000);
    expect(normalizeVolume("")).toBeNull();
    expect(normalizeVolume(-5)).toBeNull();
    expect(normalizeVolume("garbage")).toBeNull();
  });
  it("sides keep RealTrends' fractional values", () => {
    expect(normalizeSides(9.8)).toBe(9.8);
  });
  it("state codes accept USPS codes and full names", () => {
    expect(stateCode("NJ")).toBe("NJ");
    expect(stateCode("nj")).toBe("NJ");
    expect(stateCode("New Jersey")).toBe("NJ");
    expect(stateCode("Atlantis")).toBeNull();
  });
});

describe("workbook parsing", () => {
  it("reads the reporting period from the headers, never the product name", () => {
    expect(periodFromHeader(TEAMS_HEADER)).toEqual({
      productionYear: 2025,
      publicationYear: 2026,
    });
  });
  it("maps a teams row to a team record", () => {
    const { records, rejected } = parseSheet(teamsSheet([TEAM_ROW]));
    expect(rejected).toEqual({});
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r).toMatchObject({
      entityType: "team",
      entityName: "Harbor View Group",
      teamLead: "Dana",
      brokerage: "Compass",
      city: "Jersey City",
      state: "NJ",
      volumeUsd: 29_400_000,
      sides: 33,
      productionYear: 2025,
      publicationYear: 2026,
      sourceSheet: "Teams",
      sourceRow: 2,
    });
  });
  it("maps an agents row to an individual record", () => {
    const { records } = parseSheet({
      sheet: "Agents",
      header: AGENTS_HEADER,
      rows: [{ row: 2, values: ["Anne", "Pfitzenreiter", "Coldwell Banker Realty", "Sarasota", "FL", "Coldwell Banker", 9.8, 10_426_525] }],
    });
    expect(records[0]).toMatchObject({
      entityType: "individual",
      entityName: "Anne Pfitzenreiter",
      teamLead: null,
      city: "Sarasota",
      state: "FL",
    });
  });
  it("rejects malformed rows without failing the sheet", () => {
    const { records, rejected } = parseSheet(
      teamsSheet([
        TEAM_ROW,
        ["", "Lead", "Small", 3, "X", "X", "City", "NJ", 5, 1_000_000], // no name
        ["No Location", "Lead", "Small", 3, "X", "X", "", "", 5, 1_000_000],
        ["No Production", "Lead", "Small", 3, "X", "X", "City", "NJ", null, null],
        ["Bad State", "Lead", "Small", 3, "X", "X", "City", "Narnia", 5, 1_000_000],
      ])
    );
    expect(records).toHaveLength(1);
    expect(rejected).toEqual({
      MISSING_NAME: 1,
      MISSING_LOCATION: 2,
      NO_USABLE_PRODUCTION: 1,
    });
  });
});

describe("fingerprints (idempotency)", () => {
  const base = parseSheet(teamsSheet([TEAM_ROW])).records[0]!;
  it("is stable across identical imports", () => {
    const again = parseSheet(teamsSheet([TEAM_ROW])).records[0]!;
    expect(again.fingerprint).toBe(base.fingerprint);
  });
  it("differs by geography and period, not by production values", () => {
    const otherCity = parseSheet(
      teamsSheet([[...TEAM_ROW.slice(0, 6), "Hoboken", ...TEAM_ROW.slice(7)]])
    ).records[0]!;
    expect(otherCity.fingerprint).not.toBe(base.fingerprint);
    const { fingerprint: valueChanged } = {
      fingerprint: rowFingerprint({ ...base, volumeUsd: 1 }),
    };
    expect(valueChanged).toBe(base.fingerprint);
  });
});

describe("entity resolution onto companies", () => {
  const company = (over: Partial<MatchCandidateCompany> = {}): MatchCandidateCompany => ({
    id: "c1",
    name: "Harbor View Group",
    aliases: [],
    prospectTypes: ["team"],
    ...over,
  });
  const record = { entityName: "Harbor View Group", entityType: "team" as const };

  it("unique exact name in market → high confidence", () => {
    const v = classifyDatasetMatch(record, [company()]);
    expect(v.status).toBe("high_confidence");
    expect(v.companyId).toBe("c1");
  });
  it("alias match works like a name match", () => {
    const v = classifyDatasetMatch(record, [
      company({ name: "HVG Realty", aliases: ["Harbor View Group"] }),
    ]);
    expect(v.status).toBe("high_confidence");
  });
  it("no candidate in this market → unmatched (geography is caller-scoped)", () => {
    const v = classifyDatasetMatch(record, [company({ name: "Totally Different" })]);
    expect(v.status).toBe("unmatched");
    expect(v.companyId).toBeNull();
  });
  it("two exact-name companies → conflict, no auto link", () => {
    const v = classifyDatasetMatch(record, [
      company(),
      company({ id: "c2", name: "Harbor View Group" }),
    ]);
    expect(v.status).toBe("conflict");
    expect(v.companyId).toBeNull();
  });
  it("partial/probable name → review required, never auto-verified", () => {
    const v = classifyDatasetMatch(record, [company({ name: "Harbor View" })]);
    expect(v.status).toBe("review_required");
  });
  it("team record vs individual-agent prospect → review required", () => {
    const v = classifyDatasetMatch(record, [
      company({ prospectTypes: ["individual_agent"] }),
    ]);
    expect(v.status).toBe("review_required");
    expect(v.detail.reason).toContain("entity level");
  });
});
