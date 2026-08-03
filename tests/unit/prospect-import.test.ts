/**
 * Unit tests for the CSV import parser (spec 032 Phase 2.2) — pure parsing,
 * no persistence. The service-level behavior (provenance labels, dedup,
 * contact creation) is covered in tests/integration/prospect-contacts.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  IMPORT_ROW_CAP,
  parseCsv,
  parseProspectImport,
} from "@/lib/prospects/import";

describe("parseCsv", () => {
  it("splits fields on commas and rows on LF, CR, and CRLF", () => {
    expect(parseCsv("a,b\nc,d")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseCsv("a,b\r\nc,d\rE,f")).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["E", "f"],
    ]);
  });

  it("honors quoted fields with embedded commas, newlines, and escaped quotes", () => {
    expect(parseCsv('"Smith, Jane",team\n"say ""hi""",x')).toEqual([
      ["Smith, Jane", "team"],
      ['say "hi"', "x"],
    ]);
    expect(parseCsv('"line1\nline2",b')).toEqual([["line1\nline2", "b"]]);
  });

  it("drops rows that are entirely blank", () => {
    expect(parseCsv("a,b\n\n , \nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });
});

describe("parseProspectImport", () => {
  it("maps headers case/space/underscore-insensitively and reports ignored ones", () => {
    const parsed = parseProspectImport(
      "Business Name,TEAM_LEADER,Brokerage,mystery\nRivera Team,Ana Rivera,Compass,42"
    );
    expect(parsed.errors).toEqual([]);
    expect(parsed.ignoredHeaders).toEqual(["mystery"]);
    expect(parsed.rows).toEqual([
      {
        line: 2,
        businessName: "Rivera Team",
        teamLeader: "Ana Rivera",
        brokerageAffiliation: "Compass",
      },
    ]);
  });

  it("accepts name/team as business-name aliases and url as website", () => {
    const parsed = parseProspectImport("team,url\nRivera Team,riverateam.com");
    expect(parsed.rows[0]?.businessName).toBe("Rivera Team");
    expect(parsed.rows[0]?.website).toBe("riverateam.com");
  });

  it("refuses a file without a business-name column", () => {
    const parsed = parseProspectImport("email,phone\na@b.com,123");
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors[0]?.line).toBe(1);
    expect(parsed.errors[0]?.message).toContain("business_name");
  });

  it("reports per-row missing names with 1-based file line numbers", () => {
    const parsed = parseProspectImport("name,email\nRivera Team,a@b.com\n,b@c.com\nOther,c@d.com");
    expect(parsed.rows.map((r) => r.line)).toEqual([2, 4]);
    expect(parsed.errors).toEqual([{ line: 3, message: "Missing business name." }]);
  });

  it("caps at IMPORT_ROW_CAP rows and says so instead of silently truncating", () => {
    const body = Array.from({ length: IMPORT_ROW_CAP + 5 }, (_, i) => `Team ${i}`).join("\n");
    const parsed = parseProspectImport(`name\n${body}`);
    expect(parsed.rows.length).toBe(IMPORT_ROW_CAP);
    expect(parsed.errors.some((e) => e.message.includes(`${IMPORT_ROW_CAP}`))).toBe(true);
  });

  it("carries contact columns through", () => {
    const parsed = parseProspectImport(
      "name,contact_name,contact_role,contact_email\nRivera Team,Ana Rivera,Team leader,ana@riverateam.com"
    );
    expect(parsed.rows[0]).toMatchObject({
      contactName: "Ana Rivera",
      contactRole: "Team leader",
      contactEmail: "ana@riverateam.com",
    });
  });

  it("reports an empty file as a line-1 error", () => {
    const parsed = parseProspectImport("");
    expect(parsed.rows).toEqual([]);
    expect(parsed.errors[0]?.message).toContain("empty");
  });
});
