/**
 * Spec 145E — the deterministic cross-artifact claim identity and the match
 * selector. Pure functions; no database.
 */
import { describe, expect, it } from "vitest";
import {
  claimIdentity,
  normalizeClaimText,
  sameClaimIdentity,
  selectClaimMatch,
  type ClaimMatchCandidate,
} from "@/lib/knowledge/extraction/claims";

const BASE = {
  subject: "Ana Perez",
  predicate: "closed",
  category: "transaction",
  value: 40 as string | number | boolean | null,
  asOf: "2025-12-31" as string | null,
  statement: "Ana Perez closed 40 homes in 2025.",
};

function same(overrides: Partial<typeof BASE>): boolean {
  return sameClaimIdentity(claimIdentity(BASE), claimIdentity({ ...BASE, ...overrides }));
}

describe("normalizeClaimText", () => {
  it("lowercases, trims, collapses whitespace and strips trailing punctuation", () => {
    expect(normalizeClaimText("  Ana   Perez\tclosed\n40 homes.;: ")).toBe(
      "ana perez closed 40 homes"
    );
    expect(normalizeClaimText("Serves Jersey City,")).toBe("serves jersey city");
  });

  it("does not stem, reorder or drop words", () => {
    expect(normalizeClaimText("Ana Perez closes homes")).not.toBe(
      normalizeClaimText("Ana Perez closed homes")
    );
  });
});

describe("sameClaimIdentity", () => {
  it("treats an identical fact as the same claim", () => {
    expect(same({})).toBe(true);
  });

  it("ignores case and whitespace in subject and statement, and predicate spacing", () => {
    expect(
      same({
        subject: "  ana PEREZ ",
        predicate: "Closed",
        statement: "ana perez   closed 40 homes in 2025",
      })
    ).toBe(true);
  });

  it("keeps a changed value separate", () => {
    expect(same({ value: 42, statement: BASE.statement })).toBe(false);
  });

  it("keeps a changed as-of date separate", () => {
    expect(same({ asOf: "2026-06-30" })).toBe(false);
    expect(same({ asOf: null })).toBe(false);
  });

  it("distinguishes null from a value, and a number from its string", () => {
    expect(same({ value: null })).toBe(false);
    expect(same({ value: "40" })).toBe(false);
  });

  it("keeps the same wording about a different subject separate", () => {
    expect(same({ subject: "Luis Perez" })).toBe(false);
  });

  it("keeps a different predicate or category separate", () => {
    expect(same({ predicate: "listed" })).toBe(false);
    expect(same({ category: "sales_volume" })).toBe(false);
  });

  it("keeps a conflicting statement separate even when everything else matches", () => {
    const compass = {
      subject: "Ana Perez",
      predicate: "is affiliated with",
      category: "affiliation",
      value: null,
      asOf: null,
      statement: "Ana Perez is affiliated with Compass.",
    };
    expect(
      sameClaimIdentity(
        claimIdentity(compass),
        claimIdentity({ ...compass, statement: "Ana Perez is affiliated with Douglas Elliman." })
      )
    ).toBe(false);
  });

  it("does not merge paraphrases", () => {
    expect(same({ statement: "In 2025, Ana Perez closed 40 homes." })).toBe(false);
  });
});

describe("selectClaimMatch", () => {
  const at = (iso: string) => new Date(iso);
  const candidate = (over: Partial<ClaimMatchCandidate>): ClaimMatchCandidate => ({
    id: "c",
    status: "proposed",
    privacyStatus: "public",
    createdAt: at("2026-01-01T00:00:00Z"),
    ...over,
  });

  it("links to a same-privacy proposal ahead of any decided claim", () => {
    const match = selectClaimMatch(
      [
        candidate({ id: "approved", status: "approved" }),
        candidate({ id: "proposal", status: "proposed" }),
      ],
      "public"
    );
    expect(match).toEqual({ kind: "link", candidate: expect.objectContaining({ id: "proposal" }) });
  });

  it("prefers approved, then superseded, then rejected, and never links to them", () => {
    const rejected = candidate({ id: "rejected", status: "rejected" });
    const superseded = candidate({ id: "superseded", status: "superseded" });
    const approved = candidate({ id: "approved", status: "approved" });
    expect(selectClaimMatch([rejected, superseded, approved], "public")?.candidate.id).toBe(
      "approved"
    );
    expect(selectClaimMatch([rejected, superseded], "public")).toEqual({
      kind: "known",
      candidate: superseded,
    });
    expect(selectClaimMatch([rejected], "public")?.kind).toBe("known");
  });

  it("breaks ties by newest, then id", () => {
    const older = candidate({ id: "b", createdAt: at("2026-01-01T00:00:00Z") });
    const newer = candidate({ id: "z", createdAt: at("2026-02-01T00:00:00Z") });
    expect(selectClaimMatch([older, newer], "public")?.candidate.id).toBe("z");
    const tieA = candidate({ id: "a" });
    const tieB = candidate({ id: "b" });
    expect(selectClaimMatch([tieB, tieA], "public")?.candidate.id).toBe("a");
  });

  it("returns null when the only matches are proposals of another privacy class", () => {
    expect(
      selectClaimMatch([candidate({ privacyStatus: "public" })], "client_only")
    ).toBeNull();
  });

  it("falls back to a decided claim when a proposal's privacy differs", () => {
    expect(
      selectClaimMatch(
        [candidate({ id: "p", privacyStatus: "public" }), candidate({ id: "r", status: "rejected" })],
        "client_only"
      )
    ).toEqual({ kind: "known", candidate: expect.objectContaining({ id: "r" }) });
  });

  it("returns null with no candidates", () => {
    expect(selectClaimMatch([], "public")).toBeNull();
  });
});
