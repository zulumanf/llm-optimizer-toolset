/**
 * Spec 146 §10–11 — `detect_contradictions` runs on the evaluated open-weight
 * target with the v2 contract, and every failure fails closed: no clean
 * result from a bad answer, and no fallback to a paid provider.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openaiCaller: vi.fn(),
  runModeFor: vi.fn(),
}));

// Path resolution falls back to stored node outputs; there are none here.
vi.mock("@/db/client", () => ({ sql: vi.fn(async () => []) }));
vi.mock("@/lib/ai/ledger", () => ({ recordLlmCall: async () => undefined }));
vi.mock("@/lib/automation/testmode", () => ({ runModeFor: mocks.runModeFor }));
vi.mock("@/lib/ai/internal/openai", () => ({ openaiInternalCaller: mocks.openaiCaller }));

import type { NodeContext } from "@/lib/workflow/types";
import type { InternalInferenceRequest } from "@/lib/ai/internal-inference";
import { inferenceTargetForTask, TASK_ROUTES } from "@/lib/ai/routing";
import { LOCAL_INTERNAL_TARGETS } from "@/lib/ai/internal/registry";
import { AUTOMATION_PROMPTS, automationAgentVersion, withGuardrails } from "@/lib/automation/prompts";
import {
  agentGuard,
  agentNode,
  agentSchema,
  setAgentCallerForTests,
} from "@/lib/automation/nodes/agent";
import {
  DETECT_CONTRADICTIONS_V2_PREAMBLE,
  DETECT_CONTRADICTIONS_V2_SYSTEM,
  contradictionDetectionV2Schema,
  type GoldFixture,
} from "@/lib/automation/contradictions/contract";
import { DETECT_CONTRADICTIONS_GOLD } from "@/tests/fixtures/detect-contradictions-gold";
import { profileCorrectionWorkflow } from "@/lib/automation/workflows/authority";
import { graphHash } from "@/lib/workflow/engine";

const fixture = DETECT_CONTRADICTIONS_GOLD.find((f) => f.id === "s1_brokerage_change") as GoldFixture;
type Obs = { claimId: string; normalizedWording: string };
type Appr = { id: string; text: string };
const obs = (fixture.context.observedClaims as Obs[])[0]!;
const appr = (fixture.context.approvedFacts as { claims: Appr[] }).claims[0]!;

const correct = {
  contradictions: [
    {
      observedClaimId: obs.claimId,
      approvedClaimId: appr.id,
      statementA: obs.normalizedWording,
      statementB: appr.text,
      severity: "critical",
      explanation: "One brokerage cannot be both.",
    },
  ],
  confidence: 0.95,
};

function ctx(context: unknown = fixture.context): NodeContext {
  const compare = profileCorrectionWorkflow.nodes.find((n) => n.key === "compare")!;
  const { observedClaims, approvedFacts } = context as Record<string, unknown>;
  return {
    runId: "run-146",
    projectId: "project-146",
    nodeKey: "compare",
    fanKey: "",
    attempt: 1,
    inputs: {
      canonical_extract: { claims: observedClaims },
      approved_facts: approvedFacts,
    },
    workflowInput: {},
    config: compare.config ?? {},
    node: compare,
    remainingCostMicroUsd: null,
  };
}

/** A caller returning each text in turn, recording what it was sent. */
function scripted(...texts: string[]) {
  const seen: InternalInferenceRequest[] = [];
  const caller = vi.fn(async (req: InternalInferenceRequest) => {
    seen.push(req);
    const text = texts[Math.min(seen.length - 1, texts.length - 1)]!;
    return { text, tokensIn: 10, tokensOut: 10 };
  });
  return { caller, seen };
}

beforeEach(() => {
  mocks.runModeFor.mockResolvedValue({
    mode: "live",
    fixtures: { connectorResponses: {}, agentResponses: {} },
    allowCrmWrites: false,
  });
});

afterEach(() => {
  setAgentCallerForTests(undefined);
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("detect_contradictions production route", () => {
  it("routes to the evaluated local reasoning target: Ollama qwen3:30b, no paid API", () => {
    const target = inferenceTargetForTask("detect_contradictions");
    expect(target).toEqual(LOCAL_INTERNAL_TARGETS.reasoning);
    expect(target).toEqual({ backend: "ollama", model: "qwen3:30b", execution: "local" });
    expect(target.execution).not.toBe("paid_api");
    // The evaluated configuration is the model default: no reasoning override.
    expect(target).not.toHaveProperty("think");
    expect(AUTOMATION_PROMPTS.detect_contradictions.backend).toBe("ollama");
    expect(AUTOMATION_PROMPTS.detect_contradictions.model).toBe("qwen3:30b");
  });

  it("keeps the frontier judgment tier; the override, not the tier, moves the model", () => {
    expect(TASK_ROUTES.detect_contradictions.tier).toBe("frontier");
  });

  it("uses the exact v2 prompt the gold evaluation passed", () => {
    const prompt = AUTOMATION_PROMPTS.detect_contradictions;
    expect(prompt.version).toBe("detect-contradictions-v2");
    expect(prompt.system).toBe(withGuardrails(DETECT_CONTRADICTIONS_V2_SYSTEM));
    expect(prompt.userPreamble).toBe(DETECT_CONTRADICTIONS_V2_PREAMBLE);
    expect(automationAgentVersion("detect_contradictions")).toBe("detect-contradictions-v2");
    const compare = profileCorrectionWorkflow.nodes.find((n) => n.key === "compare")!;
    expect(compare.agentVersion).toBe("detect-contradictions-v2");
  });

  it("registers the v2 profile workflow as a new version (the v1 pin changes the graph hash)", () => {
    const asV1 = {
      ...profileCorrectionWorkflow,
      nodes: profileCorrectionWorkflow.nodes.map((n) =>
        n.key === "compare" ? { ...n, agentVersion: "detect-contradictions-v1" } : n
      ),
    };
    expect(graphHash(profileCorrectionWorkflow)).not.toBe(graphHash(asV1));
  });

  it("uses the v2 schema, where an omitted contradictions field is invalid", () => {
    const schema = agentSchema("detect_contradictions");
    expect(schema).toBe(contradictionDetectionV2Schema);
    expect(schema.safeParse({ confidence: 0.9 }).success).toBe(false);
    expect(schema.safeParse({ contradictions: [], confidence: 0.9 }).success).toBe(true);
  });

  it("has the deterministic validator registered as its production guard", () => {
    const guard = agentGuard("detect_contradictions");
    expect(guard).toBeDefined();
    expect(guard!.output(correct, fixture.context)).toEqual([]);
    expect(guard!.output({ ...correct, contradictions: [{ ...correct.contradictions[0]!, observedClaimId: "nope" }] }, fixture.context).length).toBeGreaterThan(0);
  });
});

describe("detect_contradictions node (live mode)", () => {
  const run = (c: NodeContext = ctx()) => agentNode("detect_contradictions")(c);

  it("sends the two named contexts and returns a validated answer", async () => {
    const { caller, seen } = scripted(JSON.stringify(correct));
    setAgentCallerForTests(caller);
    const result = await run();
    expect(result.outcome).toBe("succeeded");
    expect((result.output as { contradictions: unknown[] }).contradictions).toHaveLength(1);
    expect(seen).toHaveLength(1);
    const sent = JSON.parse(seen[0]!.user.slice(seen[0]!.user.indexOf("{"))) as {
      context: Record<string, unknown>;
    };
    expect(Object.keys(sent.context).sort()).toEqual(["approvedFacts", "observedClaims"]);
    expect(sent.context.observedClaims).toEqual(fixture.context.observedClaims);
    expect(sent.context.approvedFacts).toEqual(fixture.context.approvedFacts);
    expect(seen[0]!.model).toBe("qwen3:30b");
    expect(seen[0]!).not.toHaveProperty("think");
  });

  it("accepts an honest empty answer when it is schema-valid", async () => {
    const { caller } = scripted(JSON.stringify({ contradictions: [], confidence: 0.8 }));
    setAgentCallerForTests(caller);
    const result = await run();
    expect(result.outcome).toBe("succeeded");
  });

  const rejected: [string, unknown][] = [
    ["a fabricated observed id", { ...correct, contradictions: [{ ...correct.contradictions[0]!, observedClaimId: "00000000-0000-4000-8000-000000000000" }] }],
    ["a fabricated approved id", { ...correct, contradictions: [{ ...correct.contradictions[0]!, approvedClaimId: "00000000-0000-4000-8000-000000000001" }] }],
    ["a fabricated statement", { ...correct, contradictions: [{ ...correct.contradictions[0]!, statementA: "Ana Perez runs a bakery." }] }],
    [
      "a swapped direction",
      {
        ...correct,
        contradictions: [
          {
            ...correct.contradictions[0]!,
            observedClaimId: appr.id,
            approvedClaimId: obs.claimId,
            statementA: appr.text,
            statementB: obs.normalizedWording,
          },
        ],
      },
    ],
    ["a duplicate pair", { ...correct, contradictions: [correct.contradictions[0]!, correct.contradictions[0]!] }],
  ];

  for (const [name, answer] of rejected) {
    it(`fails closed on ${name} — never a clean result`, async () => {
      const { caller } = scripted(JSON.stringify(answer));
      setAgentCallerForTests(caller);
      const result = await run();
      expect(result.outcome).toBe("failed_terminal");
      expect(result.outcome === "failed_terminal" && result.error).toContain("deterministic guard");
      expect(result.output).toBeUndefined();
    });
  }

  it("fails closed when the contradictions field is omitted, even after the retry", async () => {
    const { caller, seen } = scripted(JSON.stringify({ confidence: 0.9 }));
    setAgentCallerForTests(caller);
    const result = await run();
    expect(result.outcome).toBe("failed_terminal");
    expect(seen).toHaveLength(2);
    expect(result.output).toBeUndefined();
  });

  it("fails closed on malformed JSON", async () => {
    const { caller } = scripted("not json", "{still not json");
    setAgentCallerForTests(caller);
    const result = await run();
    expect(result.outcome).toBe("failed_terminal");
    expect(result.output).toBeUndefined();
  });

  it("fails closed on an inference runtime failure without trying another backend", async () => {
    const caller = vi.fn(async () => {
      throw new Error("Ollama is unavailable");
    });
    setAgentCallerForTests(caller);
    const result = await run();
    expect(result.outcome).toBe("failed_terminal");
    expect(caller).toHaveBeenCalledTimes(1);
    expect(mocks.openaiCaller).not.toHaveBeenCalled();
  });

  it("refuses a missing context before calling any model", async () => {
    const { caller } = scripted(JSON.stringify({ contradictions: [], confidence: 0.9 }));
    setAgentCallerForTests(caller);
    const result = await run(ctx({ observedClaims: undefined, approvedFacts: fixture.context.approvedFacts }));
    expect(result.outcome).toBe("failed_terminal");
    expect(caller).not.toHaveBeenCalled();
  });

  it("refuses an in-flight run whose stored node is pinned to v1, without calling a model", async () => {
    const { caller } = scripted(JSON.stringify(correct));
    setAgentCallerForTests(caller);
    const old = ctx();
    const result = await run({ ...old, node: { ...old.node, agentVersion: "detect-contradictions-v1" } });
    expect(result.outcome).toBe("failed_terminal");
    expect(result.outcome === "failed_terminal" && result.error).toContain("pinned to detect-contradictions-v1");
    expect(caller).not.toHaveBeenCalled();
  });

  it("uses the real Ollama caller with no proprietary fallback when Ollama is down", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await run();
    expect(result.outcome).toBe("failed_terminal");
    expect(result.outcome === "failed_terminal" && result.error).toContain("Ollama is unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, { body: string }];
    expect(url).toMatch(/\/api\/chat$/);
    const body = JSON.parse(init.body) as Record<string, unknown>;
    expect(body.model).toBe("qwen3:30b");
    expect(body).not.toHaveProperty("think");
    expect(mocks.openaiCaller).not.toHaveBeenCalled();
  });
});
