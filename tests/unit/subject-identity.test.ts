/**
 * Spec 145D — the shared client subject identity, and discovery's unchanged
 * use of it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ sql: vi.fn() }));
vi.mock("@/db/client", () => ({ sql: mocks.sql }));

import {
  loadClientSubjectIdentity,
  subjectAllowListFor,
} from "@/lib/knowledge/entities/subject-identity";
import { DISCOVERY_PRINCIPAL_LIMIT } from "@/lib/knowledge/discovery/service";
import { subjectIsInScope } from "@/lib/knowledge/extraction/claims";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";

const COMPANY_ROW = {
  id: PROJECT_ID,
  name: "Perez Realty Group",
  aliases: ["Perez Realty"],
  domain: "perezrealty.example",
};
const PEOPLE = [
  { canonicalName: "Ana Perez" },
  { canonicalName: "Luis Perez" },
  { canonicalName: "Maya Chen" },
];

function queryText(call: unknown[]): string {
  return (call[0] as TemplateStringsArray).join("?").replace(/\s+/g, " ");
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadClientSubjectIdentity", () => {
  it("reads the subject company, its aliases and every active person of the client", async () => {
    mocks.sql.mockResolvedValueOnce([COMPANY_ROW]).mockResolvedValueOnce(PEOPLE);
    const lookup = await loadClientSubjectIdentity(PROJECT_ID);
    expect(lookup).toEqual({
      status: "resolved",
      identity: {
        name: "Perez Realty Group",
        aliases: ["Perez Realty"],
        domain: "perezrealty.example",
        principals: ["Ana Perez", "Luis Perez", "Maya Chen"],
      },
    });
  });

  it("scopes both reads to the one project and excludes shared or foreign entities", async () => {
    mocks.sql.mockResolvedValueOnce([COMPANY_ROW]).mockResolvedValueOnce(PEOPLE);
    await loadClientSubjectIdentity(PROJECT_ID);
    const [companyCall, peopleCall] = mocks.sql.mock.calls;
    expect(queryText(companyCall!)).toContain("left join companies c on c.id = p.subject_company_id");
    expect(companyCall!.slice(1)).toEqual([PROJECT_ID]);

    const people = queryText(peopleCall!);
    expect(people).toContain("from knowledge_entities");
    expect(people).toContain("where project_id = ?");
    expect(people).toContain("entity_type = 'person'");
    expect(people).toContain("status = 'active'");
    // Uncapped by default (`limit null`).
    expect(peopleCall!.slice(1)).toEqual([PROJECT_ID, null]);
  });

  it("applies a principal cap when asked and can skip the principal read", async () => {
    mocks.sql.mockResolvedValueOnce([COMPANY_ROW]).mockResolvedValueOnce(PEOPLE.slice(0, 2));
    await loadClientSubjectIdentity(PROJECT_ID, { principalLimit: 2 });
    expect(mocks.sql.mock.calls[1]!.slice(1)).toEqual([PROJECT_ID, 2]);

    mocks.sql.mockReset();
    mocks.sql.mockResolvedValueOnce([COMPANY_ROW]);
    const lookup = await loadClientSubjectIdentity(PROJECT_ID, { skipPrincipals: true });
    expect(mocks.sql).toHaveBeenCalledTimes(1);
    expect(lookup.status === "resolved" && lookup.identity.principals).toEqual([]);
  });

  it("reports an unknown client and a client with no subject company", async () => {
    mocks.sql.mockResolvedValueOnce([]);
    expect(await loadClientSubjectIdentity(PROJECT_ID)).toEqual({ status: "client_not_found" });

    mocks.sql.mockResolvedValueOnce([{ id: PROJECT_ID, name: null, aliases: null, domain: null }]);
    expect(await loadClientSubjectIdentity(PROJECT_ID)).toEqual({ status: "no_subject_company" });
    // No person read happens for an unresolved client.
    expect(mocks.sql).toHaveBeenCalledTimes(2);
  });
});

describe("subjectAllowListFor", () => {
  it("orders name, aliases, principals; trims, drops blanks, de-duplicates case-insensitively", () => {
    expect(
      subjectAllowListFor({
        name: " Perez Realty Group ",
        aliases: ["Perez Realty", "perez realty group", "  ", "PEREZ REALTY"],
        principals: ["Ana Perez", "", "ana perez", "Maya Chen"],
      })
    ).toEqual(["Perez Realty Group", "Perez Realty", "Ana Perez", "Maya Chen"]);
  });

  it("yields an empty list for an identity with no usable name", () => {
    expect(subjectAllowListFor({ name: "  ", aliases: [""], principals: [] })).toEqual([]);
  });

  it("feeds the existing deterministic filter unchanged", () => {
    const allow = subjectAllowListFor({
      name: "Perez Realty Group",
      aliases: ["Perez Realty"],
      principals: ["Ana Perez", "Maya Chen"],
    });
    expect(subjectIsInScope("Perez Realty Group", allow)).toBe(true);
    expect(subjectIsInScope("Maya Chen", allow)).toBe(true);
    expect(subjectIsInScope("Greystar", allow)).toBe(false);
    expect(subjectIsInScope("Other Agent", allow)).toBe(false);
  });
});

describe("discovery identity (regression)", () => {
  it("keeps its two-principal cap", () => {
    expect(DISCOVERY_PRINCIPAL_LIMIT).toBe(2);
  });
});
