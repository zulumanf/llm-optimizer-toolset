/**
 * Unit tests for the deterministic field-mapping layer, the event filter
 * evaluator, and the pure attribution classifier.
 *
 * The mapping layer is where an LLM's suggestion becomes a stored, approved,
 * reproducible transform. The test that matters most here is the one asserting
 * a non-approved mapping cannot be applied — that is the enforcement point for
 * "an LLM may suggest, only a human approves".
 */
import { describe, expect, it } from "vitest";
import {
  applyMapping,
  applyMappingBatch,
  normalizeDomain,
  normalizeEmail,
  normalizeEmailForMatching,
  normalizePhone,
  normalizeUrl,
  parseCurrencyToCents,
  type MappingVersion,
} from "@/lib/connectors/mapping";
import { matchesFilter, readPath, renderIdempotencyKey } from "@/lib/events/filter";
import { eventDefinition, knownEventTypes, eventTypesByGroup } from "@/lib/events/catalog";
import { classifyAttribution } from "@/lib/automation/nodes/deterministic";
import { toCents } from "@/lib/connectors/adapters/crm";
import { parseDelimited } from "@/lib/connectors/adapters/internal";
import { ClassifiedError } from "@/lib/errors";

const approvedMapping: MappingVersion = {
  definitionId: "def-1",
  version: 1,
  status: "approved",
  approvedBy: "user-1",
  suggestedByAgent: null,
  fields: [
    {
      sourceField: "Estimated GCI",
      destinationField: "estimated_commission",
      dataType: "currency",
      required: true,
      defaultValue: null,
      transform: "parse_currency",
      validation: "non_negative",
    },
    {
      sourceField: "Email",
      destinationField: "email",
      dataType: "string",
      required: true,
      defaultValue: null,
      transform: "normalize_email",
      validation: "email",
    },
    {
      sourceField: "Phone",
      destinationField: "phone",
      dataType: "string",
      required: false,
      defaultValue: null,
      transform: "normalize_phone",
      validation: "phone",
    },
    {
      sourceField: "Website",
      destinationField: "website",
      dataType: "string",
      required: false,
      defaultValue: null,
      transform: "normalize_url",
      validation: "url",
    },
    {
      sourceField: "Active",
      destinationField: "is_active",
      dataType: "boolean",
      required: false,
      defaultValue: false,
      transform: "boolean",
      validation: "none",
    },
  ],
};

describe("normalisers", () => {
  it("normalises an email for storage without dropping the plus-tag", () => {
    expect(normalizeEmail("  Agent+Campaign@Example.COM ")).toBe("agent+campaign@example.com");
  });

  it("strips plus-tags for MATCHING, so suppression cannot be bypassed", () => {
    // This is the detail that separates having a suppression list from
    // appearing to have one.
    expect(normalizeEmailForMatching("Agent+campaign@Example.com")).toBe("agent@example.com");
    expect(normalizeEmailForMatching("agent@example.com")).toBe("agent@example.com");
    expect(normalizeEmailForMatching("a+b+c@example.com")).toBe("a@example.com");
  });

  it("normalises phones toward E.164", () => {
    expect(normalizePhone("(305) 555-0147")).toBe("+13055550147");
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
    expect(normalizePhone("13055550147")).toBe("+13055550147");
    expect(normalizePhone("")).toBe("");
  });

  it("canonicalises URLs", () => {
    expect(normalizeUrl("HTTPS://WWW.Example.com/Path/")).toBe("https://example.com/Path");
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("https://example.com:443/a")).toBe("https://example.com/a");
    expect(normalizeUrl("https://example.com/a#frag")).toBe("https://example.com/a");
    expect(normalizeUrl("")).toBe("");
  });

  it("extracts a registrable domain", () => {
    expect(normalizeDomain("https://www.brokerage.com/agents/x")).toBe("brokerage.com");
    expect(normalizeDomain("brokerage.com")).toBe("brokerage.com");
  });

  it("parses currency into integer cents", () => {
    expect(parseCurrencyToCents("$1,250.50")).toBe(125_050);
    expect(parseCurrencyToCents("1250")).toBe(125_000);
    expect(parseCurrencyToCents("$0.99")).toBe(99);
    expect(parseCurrencyToCents("")).toBeNull();
    expect(parseCurrencyToCents("not money")).toBeNull();
  });

  it("converts CRM amounts to cents without float drift", () => {
    expect(toCents("402.35")).toBe(40_235);
    expect(toCents(402.35)).toBe(40_235);
    expect(toCents("$1,000")).toBe(100_000);
    expect(toCents(null)).toBeNull();
    expect(toCents("")).toBeNull();
  });
});

describe("applyMapping", () => {
  it("maps and transforms a well-formed record", () => {
    const result = applyMapping(approvedMapping, {
      "Estimated GCI": "$45,000.00",
      Email: "Agent@Example.COM",
      Phone: "(305) 555-0147",
      Website: "www.example.com",
      Active: "yes",
    });
    expect(result.ok).toBe(true);
    expect(result.record.estimated_commission).toBe(4_500_000);
    expect(result.record.email).toBe("agent@example.com");
    expect(result.record.phone).toBe("+13055550147");
    expect(result.record.website).toBe("https://example.com");
    expect(result.record.is_active).toBe(true);
  });

  it("refuses a mapping version that is not approved", () => {
    // The enforcement point for "an LLM may suggest, only a human approves".
    const proposed: MappingVersion = {
      ...approvedMapping,
      status: "proposed",
      approvedBy: null,
      suggestedByAgent: "map-suggester-v1",
    };
    expect(() => applyMapping(proposed, {})).toThrow(ClassifiedError);
    expect(() => applyMapping(proposed, {})).toThrow(/still needs human approval/);
  });

  it("refuses a deprecated mapping version", () => {
    expect(() => applyMapping({ ...approvedMapping, status: "deprecated" }, {})).toThrow(
      /Only an approved mapping/
    );
  });

  it("reports a missing required field rather than defaulting it", () => {
    const result = applyMapping(approvedMapping, { Email: "a@b.co" });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("estimated_commission");
    expect(result.errors.join(" ")).toContain("required");
  });

  it("applies a default for an absent optional field", () => {
    const result = applyMapping(approvedMapping, {
      "Estimated GCI": "1000",
      Email: "a@b.co",
    });
    expect(result.ok).toBe(true);
    expect(result.record.is_active).toBe(false);
    expect(result.record.phone).toBeNull();
  });

  it("reports a validation failure per field", () => {
    const result = applyMapping(approvedMapping, {
      "Estimated GCI": "1000",
      Email: "not-an-email",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("not a valid email");
  });

  it("reports a transform failure distinctly from a validation failure", () => {
    const result = applyMapping(approvedMapping, {
      "Estimated GCI": "abc",
      Email: "a@b.co",
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("not a currency amount");
  });

  it("surfaces unmapped source fields rather than dropping them silently", () => {
    const result = applyMapping(approvedMapping, {
      "Estimated GCI": "1000",
      Email: "a@b.co",
      "Some Custom Field": "value",
      "Another One": "value",
    });
    expect(result.unmappedSourceFields).toContain("Some Custom Field");
    expect(result.unmappedSourceFields).toContain("Another One");
  });
});

describe("applyMappingBatch", () => {
  it("maps the good rows and reports the bad ones by index", () => {
    const result = applyMappingBatch(approvedMapping, [
      { "Estimated GCI": "1000", Email: "a@b.co" },
      { "Estimated GCI": "bad", Email: "c@d.co" },
      { "Estimated GCI": "2000", Email: "e@f.co" },
    ]);
    // A partial import that reported success would be silent data loss.
    expect(result.mapped).toHaveLength(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.index).toBe(1);
  });
});

describe("CSV parsing", () => {
  it("parses a simple document", () => {
    const rows = parseDelimited("name,email\nAlice,a@b.co\nBob,b@c.co");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ name: "Alice", email: "a@b.co" });
  });

  it("handles quoted fields containing the delimiter", () => {
    // Real-estate addresses are full of commas; a naive split corrupts them.
    const rows = parseDelimited('address,price\n"123 Main St, Apt 4",500000');
    expect(rows[0]!.address).toBe("123 Main St, Apt 4");
    expect(rows[0]!.price).toBe("500000");
  });

  it("handles escaped quotes", () => {
    const rows = parseDelimited('note\n"She said ""yes"" today"');
    expect(rows[0]!.note).toBe('She said "yes" today');
  });

  it("ignores blank lines and trailing newlines", () => {
    const rows = parseDelimited("a,b\n1,2\n\n3,4\n");
    expect(rows).toHaveLength(2);
  });

  it("returns nothing for an empty document", () => {
    expect(parseDelimited("")).toEqual([]);
  });
});

describe("event filters", () => {
  const payload = { score: 75, qualified: true, market: "miami", nested: { depth: 3 } };

  it("always matches the always filter", () => {
    expect(matchesFilter({ kind: "always" }, payload)).toBe(true);
    expect(matchesFilter({ kind: "always" }, {})).toBe(true);
  });

  it("matches on equality", () => {
    expect(matchesFilter({ kind: "payload_equals", path: "market", value: "miami" }, payload)).toBe(true);
    expect(matchesFilter({ kind: "payload_equals", path: "market", value: "austin" }, payload)).toBe(false);
  });

  it("matches numeric thresholds", () => {
    expect(matchesFilter({ kind: "payload_gte", path: "score", value: 70 }, payload)).toBe(true);
    expect(matchesFilter({ kind: "payload_gte", path: "score", value: 80 }, payload)).toBe(false);
    expect(matchesFilter({ kind: "payload_lt", path: "score", value: 80 }, payload)).toBe(true);
  });

  it("does not treat a non-numeric value as satisfying a numeric filter", () => {
    expect(matchesFilter({ kind: "payload_gte", path: "market", value: 0 }, payload)).toBe(false);
    expect(matchesFilter({ kind: "payload_gte", path: "missing", value: 0 }, payload)).toBe(false);
  });

  it("matches truthiness", () => {
    expect(matchesFilter({ kind: "payload_truthy", path: "qualified" }, payload)).toBe(true);
    expect(matchesFilter({ kind: "payload_truthy", path: "missing" }, payload)).toBe(false);
  });

  it("reads nested paths", () => {
    expect(readPath(payload, "nested.depth")).toBe(3);
    expect(readPath(payload, "nested.missing")).toBeUndefined();
    expect(readPath(payload, "market.deeper")).toBeUndefined();
  });
});

describe("idempotency key rendering", () => {
  const event = {
    id: "evt-1",
    type: "lead.created",
    projectId: "proj-1",
    payload: { leadId: "lead-9", email: "a@b.co" },
  };

  it("renders the supported placeholders", () => {
    expect(renderIdempotencyKey("evt:{{event.id}}", event)).toBe("evt:evt-1");
    expect(renderIdempotencyKey("{{event.type}}:{{event.projectId}}", event)).toBe(
      "lead.created:proj-1"
    );
    expect(renderIdempotencyKey("lead:{{payload.leadId}}", event)).toBe("lead:lead-9");
  });

  it("renders a platform-scoped event's project as 'platform'", () => {
    expect(renderIdempotencyKey("{{event.projectId}}", { ...event, projectId: null })).toBe(
      "platform"
    );
  });

  it("throws rather than rendering a hole into the key", () => {
    // A key with a hole in it collapses unrelated runs onto each other.
    expect(() => renderIdempotencyKey("lead:{{payload.missing}}", event)).toThrow(/missing value/);
  });

  it("rejects an unsupported placeholder", () => {
    expect(() => renderIdempotencyKey("{{env.SECRET}}", event)).toThrow(/Unsupported/);
  });

  it("bounds the key length", () => {
    const long = renderIdempotencyKey(`${"x".repeat(300)}{{event.id}}`, event);
    expect(long.length).toBeLessThanOrEqual(200);
  });
});

describe("event catalogue", () => {
  it("declares every event type the spec names", () => {
    const types = knownEventTypes();
    for (const expected of [
      "client.created",
      "client.onboarding_started",
      "client.onboarding_completed",
      "benchmark.started",
      "benchmark.completed",
      "benchmark.partially_failed",
      "visibility.materially_declined",
      "visibility.materially_improved",
      "claim.created",
      "claim.expired",
      "claim.conflict_detected",
      "claim.approved",
      "content.opportunity_created",
      "content.approved",
      "content.published",
      "profile.error_detected",
      "profile.correction_approved",
      "profile.correction_verified",
      "transaction.created",
      "transaction.verified",
      "lead.created",
      "lead.qualified",
      "lead.ai_discovery_reported",
      "opportunity.created",
      "opportunity.stage_changed",
      "opportunity.closed_won",
      "integration.connection_failed",
      "integration.authorization_expired",
      "approval.requested",
      "approval.approved",
      "approval.rejected",
      "invoice.created",
      "invoice.overdue",
      "invoice.paid",
    ]) {
      expect(types, `${expected} must be declared`).toContain(expected);
    }
  });

  it("versions every declaration", () => {
    for (const type of knownEventTypes()) {
      const definition = eventDefinition(type);
      expect(definition?.version).toBeGreaterThanOrEqual(1);
      expect(definition?.schema).toBeDefined();
      expect(definition?.description.length).toBeGreaterThan(0);
    }
  });

  it("returns undefined for an unknown type", () => {
    expect(eventDefinition("made.up")).toBeUndefined();
  });

  it("groups types by prefix for the UI", () => {
    const groups = eventTypesByGroup();
    expect(groups.get("claim")?.length).toBeGreaterThan(2);
    expect(groups.get("invoice")?.length).toBe(3);
  });

  it("requires a sample size on a materiality event", () => {
    const definition = eventDefinition("visibility.materially_declined")!;
    // A movement without its sample is a number we are not willing to act on.
    const withoutSample = definition.schema.safeParse({
      metric: "recommendation_rate",
      previous: 0.4,
      current: 0.2,
      deltaPct: -50,
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
    expect(withoutSample.success).toBe(false);
  });

  it("marks a prospect event as platform-scoped", () => {
    expect(eventDefinition("prospect.identified")?.requiresProject).toBe(false);
    expect(eventDefinition("claim.expired")?.requiresProject).toBe(true);
  });
});

describe("attribution classification", () => {
  it("classifies a self-reported discovery as confirmed", () => {
    const result = classifyAttribution({
      selfReported: true,
      selfReportedText: "I asked ChatGPT for the best agent in Coral Gables and you came up",
    });
    expect(result.category).toBe("confirmed_self_reported_ai_discovery");
  });

  it("classifies an AI referrer as confirmed", () => {
    const result = classifyAttribution({ aiReferrerPresent: true });
    expect(result.category).toBe("confirmed_ai_referral");
  });

  it("classifies branded lift plus visibility gain as assisted, not confirmed", () => {
    const result = classifyAttribution({
      brandedSearchLift: true,
      visibilityImprovedInPeriod: true,
    });
    expect(result.category).toBe("ai_assisted");
    expect(result.category).not.toContain("confirmed");
  });

  it("classifies a bare correlation as probable, never confirmed", () => {
    // The single most important property in this file: correlation does not
    // become confirmation.
    const result = classifyAttribution({ visibilityImprovedInPeriod: true });
    expect(result.category).toBe("probable_ai_influence");
  });

  it("refuses to attribute when another channel was active", () => {
    const result = classifyAttribution({
      visibilityImprovedInPeriod: true,
      otherChannelsActive: true,
    });
    expect(result.category).toBe("unknown");
  });

  it("returns unknown with no signal at all", () => {
    const result = classifyAttribution({});
    expect(result.category).toBe("unknown");
    expect(result.rule).toContain("no signal");
  });

  it("requires self-reported text, not just the flag", () => {
    const result = classifyAttribution({ selfReported: true, selfReportedText: "" });
    expect(result.category).not.toBe("confirmed_self_reported_ai_discovery");
  });

  it("names the rule behind every classification", () => {
    for (const signals of [
      { aiReferrerPresent: true },
      { visibilityImprovedInPeriod: true },
      {},
    ]) {
      expect(classifyAttribution(signals).rule.length).toBeGreaterThan(10);
    }
  });
});
