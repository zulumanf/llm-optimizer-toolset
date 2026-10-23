/**
 * Spec 145E — cross-artifact de-duplication inside extractClaimsFromSource's
 * storage transaction, against an in-memory stand-in for the claims and
 * evidence tables. The database-backed proof (real SQL, locking, concurrency)
 * lives in tests/integration/claim-cross-artifact-dedup.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeClaim {
  id: string;
  projectId: string;
  status: string;
  privacyStatus: string;
  createdAt: Date;
  subjectEntity: string;
  normalizedPredicate: string;
  category: string;
  value: unknown;
  asOf: string | null;
  canonicalText: string;
  evidenceIds: string[];
  sourceArtifactIds: string[];
}

const { db, agent, sqlMock, PAGE } = vi.hoisted(() => {
  interface Claim {
    id: string;
    projectId: string;
    status: string;
    privacyStatus: string;
    createdAt: Date;
    subjectEntity: string;
    normalizedPredicate: string;
    category: string;
    value: unknown;
    asOf: string | null;
    canonicalText: string;
    evidenceIds: string[];
    sourceArtifactIds: string[];
  }
  const db = {
    claims: [] as Claim[],
    evidence: [] as { id: string; projectId: string; refId: string }[],
    artifact: {} as Record<string, unknown>,
    locks: [] as string[],
    events: [] as { type: string; projectId: string }[],
    audits: [] as { detail: Record<string, unknown> }[],
    seq: 0,
  };
  const agent = { claims: [] as unknown[] };
  const PAGE =
    "Ana Perez closed 40 homes in 2025. Luis Perez closed 40 homes in 2025. Ana Perez closed 42 homes in 2025.";

  const text = (strings: TemplateStringsArray): string => strings.join("?").replace(/\s+/g, " ");
  const nextId = (prefix: string): string => {
    db.seq += 1;
    return `${prefix}-${db.seq}`;
  };

  const tx = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const q = text(strings);
      if (q.includes("pg_advisory_xact_lock")) {
        db.locks.push(String(values[0]));
        return [];
      }
      if (q.includes("insert into evidence")) {
        const id = nextId("ev");
        db.evidence.push({ id, projectId: String(values[0]), refId: String(values[1]) });
        return [{ id }];
      }
      if (q.includes("from claims") && q.includes("for update")) {
        const [projectId, predicate, statuses] = values as [string, string, string[]];
        return db.claims
          .filter(
            (c) =>
              c.projectId === projectId &&
              c.normalizedPredicate === predicate &&
              statuses.includes(c.status)
          )
          .map((c) => ({ ...c }));
      }
      if (q.includes("update claims set") && q.includes("array_append")) {
        const [evidenceId, artifactId, , claimId] = values as string[];
        const claim = db.claims.find((c) => c.id === claimId && c.status === "proposed");
        if (claim) {
          claim.evidenceIds.push(evidenceId!);
          if (!claim.sourceArtifactIds.includes(artifactId!)) claim.sourceArtifactIds.push(artifactId!);
        }
        return [];
      }
      if (q.includes("insert into claims")) {
        const id = nextId("claim");
        const v = values;
        db.claims.push({
          id,
          projectId: v[0] as string,
          canonicalText: v[2] as string,
          value: v[3] === null ? null : (v[3] as { json: unknown }).json,
          asOf: v[4] as string | null,
          evidenceIds: [...(v[5] as string[])],
          normalizedPredicate: v[7] as string,
          subjectEntity: v[8] as string,
          category: v[10] as string,
          privacyStatus: v[13] as string,
          sourceArtifactIds: [...(v[14] as string[])],
          status: "proposed",
          createdAt: new Date(),
        });
        return [{ id }];
      }
      return [];
    },
    { json: (value: unknown) => ({ json: value }) }
  );

  const sqlMock = Object.assign(
    async (strings: TemplateStringsArray) => {
      if (text(strings).includes("from source_artifacts where id")) return [db.artifact];
      return [];
    },
    { begin: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) }
  );

  return { db, agent, sqlMock, PAGE };
});

vi.mock("@/db/client", () => ({ sql: sqlMock }));
vi.mock("@/db/audit", () => ({
  writeAudit: async (_tx: unknown, entry: { detail: Record<string, unknown> }) => {
    db.audits.push(entry);
  },
}));
vi.mock("@/lib/auth", () => ({ assertCanWrite: () => undefined }));
vi.mock("@/lib/events/bus", () => ({
  publishEvent: async (_tx: unknown, event: { type: string; projectId: string }) => {
    db.events.push(event);
  },
}));
vi.mock("@/lib/ai/routing", () => ({
  inferenceTargetForTask: () => ({ model: "local-test", backend: "ollama" }),
}));
vi.mock("@/lib/ai/agent", () => ({
  runAgent: async () => ({ output: { claims: agent.claims }, costMicroUsd: 0 }),
}));
vi.mock("@/lib/knowledge/sources/ingest", () => ({
  latestExtraction: async () => ({
    text: PAGE,
    structured: null,
    spans: [],
    extractorKey: "html",
    extractorVersion: "1",
    status: "extracted",
  }),
}));
vi.mock("@/lib/knowledge/entities/service", () => ({
  resolveEntityByName: async () => ({ matchStatus: "unmatched", entityId: null }),
}));
vi.mock("@/lib/knowledge/contradictions/detect", () => ({
  scanProjectContradictions: async () => ({ recorded: 0 }),
}));

import { extractClaimsFromSource } from "@/lib/knowledge/extraction/claims";
import type { CurrentUser } from "@/lib/auth";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER_PROJECT = "22222222-2222-4222-8222-222222222222";
const ARTIFACT_V2 = "44444444-4444-4444-8444-444444444444";
const USER: CurrentUser = { id: "u", email: "u@x", name: "U", role: "operator" };

function draft(over: Record<string, unknown> = {}) {
  return {
    subject: "Ana Perez",
    predicate: "closed",
    object: "40 homes",
    originalWording: "Ana Perez closed 40 homes in 2025.",
    normalizedWording: "Ana Perez closed 40 homes in 2025.",
    category: "transaction",
    asOf: "2025-12-31",
    value: 40,
    confidence: 0.9,
    locator: "",
    ...over,
  };
}

function existing(over: Partial<FakeClaim> = {}): FakeClaim {
  return {
    id: "existing",
    projectId: PROJECT,
    status: "proposed",
    privacyStatus: "public",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    subjectEntity: "Ana Perez",
    normalizedPredicate: "closed",
    category: "transaction",
    value: 40,
    asOf: "2025-12-31",
    canonicalText: "Ana Perez closed 40 homes in 2025.",
    evidenceIds: ["ev-old"],
    sourceArtifactIds: ["artifact-v1"],
    ...over,
  };
}

async function extract(drafts: unknown[], allow?: string[]) {
  agent.claims = drafts;
  const result = await extractClaimsFromSource(USER, {
    sourceArtifactId: ARTIFACT_V2,
    ...(allow ? { subjectAllowList: allow } : {}),
  });
  if (!result.ok) throw new Error(result.error.message);
  return result.data;
}

beforeEach(() => {
  db.claims = [];
  db.evidence = [];
  db.locks = [];
  db.events = [];
  db.audits = [];
  db.seq = 0;
  db.artifact = {
    id: ARTIFACT_V2,
    projectId: PROJECT,
    sourceType: "website",
    originalFilename: null,
    originalUrl: "https://directory.example.com/ana",
    extractionStatus: "extracted",
    privacyClassification: "public",
    effectiveDate: null,
  };
});

describe("extractClaimsFromSource cross-artifact de-duplication", () => {
  it("links a restated fact to the existing same-privacy proposal", async () => {
    db.claims.push(existing());
    const result = await extract([draft()]);

    expect(result.proposed).toEqual([]);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]).toMatchObject({
      claimId: "existing",
      existingStatus: "proposed",
      resolution: "linked",
    });
    expect(db.claims).toHaveLength(1);
    const evidenceId = result.matched[0]!.evidenceId;
    expect(db.claims[0]!.evidenceIds).toEqual(["ev-old", evidenceId]);
    expect(db.claims[0]!.sourceArtifactIds).toEqual(["artifact-v1", ARTIFACT_V2]);
    expect(db.evidence).toEqual([{ id: evidenceId, projectId: PROJECT, refId: ARTIFACT_V2 }]);
    expect(db.events.filter((e) => e.type === "claim.proposed")).toEqual([]);
  });

  it.each([["approved"], ["superseded"], ["rejected"]])(
    "does not re-propose or mutate a %s claim, but keeps the new evidence",
    async (status) => {
      db.claims.push(existing({ status }));
      const before = structuredClone(db.claims[0]!);
      const result = await extract([draft()]);

      expect(result.proposed).toEqual([]);
      expect(result.matched[0]).toMatchObject({
        claimId: "existing",
        existingStatus: status,
        resolution: "already_known",
      });
      expect(db.claims).toEqual([before]);
      expect(db.evidence).toHaveLength(1);
      expect(db.evidence[0]!.refId).toBe(ARTIFACT_V2);
      expect(db.events).toEqual([]);
      expect(db.audits[0]!.detail.matched).toEqual([
        {
          claimId: "existing",
          status,
          evidenceId: result.matched[0]!.evidenceId,
          resolution: "already_known",
        },
      ]);
    }
  );

  it("never matches another project's identical claim", async () => {
    db.claims.push(existing({ projectId: OTHER_PROJECT }));
    const result = await extract([draft()]);
    expect(result.matched).toEqual([]);
    expect(result.proposed).toHaveLength(1);
    expect(db.claims.find((c) => c.projectId === OTHER_PROJECT)!.evidenceIds).toEqual(["ev-old"]);
  });

  it.each([
    ["a changed value", { value: 42, normalizedWording: "Ana Perez closed 42 homes in 2025.", originalWording: "Ana Perez closed 42 homes in 2025." }],
    ["a changed as-of date", { asOf: "2026-06-30" }],
    ["a different subject with the same wording", { subject: "Luis Perez", normalizedWording: "Luis Perez closed 40 homes in 2025.", originalWording: "Luis Perez closed 40 homes in 2025." }],
  ])("inserts %s as a new proposal", async (_label, over) => {
    db.claims.push(existing({ status: "approved" }));
    const result = await extract([draft(over)]);
    expect(result.matched).toEqual([]);
    expect(result.proposed).toHaveLength(1);
    expect(db.claims).toHaveLength(2);
    expect(db.claims[1]!.status).toBe("proposed");
    expect(db.events.filter((e) => e.type === "claim.proposed")).toHaveLength(1);
  });

  it("inserts a new proposal rather than linking across a privacy class", async () => {
    db.claims.push(existing({ privacyStatus: "public" }));
    db.artifact.privacyClassification = "client_only";
    const result = await extract([draft()]);
    expect(result.matched).toEqual([]);
    expect(result.proposed).toHaveLength(1);
    expect(db.claims[0]!.evidenceIds).toEqual(["ev-old"]);
    expect(db.claims[1]!.privacyStatus).toBe("client_only");
  });

  it("takes the project's claim lock before reading candidates", async () => {
    await extract([draft()]);
    expect(db.locks).toEqual([`claims:${PROJECT}`]);
  });

  it("still applies the subject allow list and the verbatim guard first", async () => {
    db.claims.push(existing({ status: "approved" }));
    const result = await extract(
      [
        draft({ subject: "Luis Perez", normalizedWording: "Luis Perez closed 40 homes in 2025.", originalWording: "Luis Perez closed 40 homes in 2025." }),
        draft({ originalWording: "Ana Perez closed 400 homes in 2025." }),
      ],
      ["Ana Perez"]
    );
    expect(result.proposed).toEqual([]);
    expect(result.matched).toEqual([]);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      'The subject "Luis Perez" is not this client or one of its people.',
      "The quoted wording does not appear in the source document.",
    ]);
    expect(db.evidence).toEqual([]);
  });

  it("links a second in-run restatement to the proposal made earlier in the same run", async () => {
    const result = await extract([
      draft(),
      draft({ originalWording: "Ana Perez closed 40 homes", locator: "footer" }),
    ]);
    expect(result.proposed).toHaveLength(1);
    expect(result.matched).toHaveLength(1);
    expect(result.matched[0]!.claimId).toBe(result.proposed[0]!.claimId);
    expect(db.claims).toHaveLength(1);
    expect(db.claims[0]!.sourceArtifactIds).toEqual([ARTIFACT_V2]);
    expect(db.claims[0]!.evidenceIds).toHaveLength(2);
  });
});
