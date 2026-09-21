import { describe, expect, it } from "vitest";
import { eventDefinition } from "@/lib/events/catalog";
import { normalizeLeadInput } from "@/lib/automation/nodes/deterministic";
import { inboundLeadWorkflow } from "@/lib/automation/workflows/revenue";

describe("lead intake contract", () => {
  it("preserves the real lead facts the intake layer knows", () => {
    const definition = eventDefinition("lead.created");

    expect(definition).toBeDefined();
    expect(definition!.requiresProject).toBe(false);

    const parsed = definition!.schema.parse({
      leadId: "lead-1",
      email: "agent@example.com",
      company: "Rivera Team",
      sourceChannel: "marketing_site",
      name: "Ana Rivera",
      website: "https://example.com",
      market: "Jersey City, NJ",
      specialization: "Luxury residential",
    });

    expect(parsed).toMatchObject({
      leadId: "lead-1",
      email: "agent@example.com",
      company: "Rivera Team",
      sourceChannel: "marketing_site",
      name: "Ana Rivera",
      website: "https://example.com",
      market: "Jersey City, NJ",
      specialization: "Luxury residential",
    });
  });

  it("remains backward compatible with minimal lead events", () => {
    const definition = eventDefinition("lead.created")!;

    const parsed = definition.schema.parse({
      leadId: "lead-2",
      email: "agent@example.com",
    });

    expect(parsed.company).toBe("");
    expect(parsed.sourceChannel).toBe("unknown");
    expect(parsed.name).toBe("");
    expect(parsed.website).toBe("");
    expect(parsed.market).toBe("");
    expect(parsed.specialization).toBe("");
  });

  it("treats lead qualification as a platform-capable event", () => {
    const definition = eventDefinition("lead.qualified");

    expect(definition).toBeDefined();
    expect(definition!.requiresProject).toBe(false);
  });

  it("normalizes lead facts without throwing useful context away", () => {
    const result = normalizeLeadInput({
      leadId: " lead-3 ",
      name: " Ana   Rivera ",
      email: "Agent@Example.com",
      company: " Rivera   Team ",
      website: "https://example.com",
      market: " Jersey   City, NJ ",
      specialization: " Luxury   Residential ",
      sourceChannel: " marketing_site ",
    });

    expect(result.normalized.leadId).toBe("lead-3");
    expect(result.normalized.name).toBe("Ana Rivera");
    expect(result.normalized.email).toBe("agent@example.com");
    expect(result.normalized.company).toBe("Rivera Team");
    expect(result.normalized.market).toBe("Jersey City, NJ");
    expect(result.normalized.specialization).toBe(
      "Luxury Residential"
    );
    expect(result.normalized.sourceChannel).toBe(
      "marketing_site"
    );
    expect(result.normalized.website).toContain(
      "example.com"
    );
  });

  it("uses the dedicated lead normalizer in the inbound workflow", () => {
    const node = inboundLeadWorkflow.nodes.find(
      (candidate) => candidate.key === "normalize"
    );

    expect(node?.handler).toBe("det.normalize_lead");
  });
});
