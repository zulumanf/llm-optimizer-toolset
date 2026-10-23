import { zodToJsonSchema } from "zod-to-json-schema";
import { AUTOMATION_PROMPTS } from "@/lib/automation/prompts";
import { agentSchema } from "@/lib/automation/nodes/agent";

const MODEL = "qwen3:8b";
const OLLAMA_URL =
  process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const REPS = 2;

if (process.env.OPENAI_API_KEY) {
  throw new Error(
    "OPENAI_API_KEY must be unset for this local-model promotion eval"
  );
}

type SupportOutput = {
  category:
    | "report_timing"
    | "workflow_status"
    | "approval_request"
    | "access_instructions"
    | "metric_definition"
    | "integration_status"
    | "strategic_advice"
    | "pricing"
    | "complaint"
    | "legal"
    | "privacy"
    | "attribution_dispute"
    | "scope_change"
    | "other";
  urgency: "low" | "normal" | "high" | "critical";
  autoResponseAllowed: boolean;
  suggestedResponse: string;
  escalationReason: string;
  confidence: number;
};

type Fixture = {
  id: string;
  message: {
    senderEmail: string;
    subject: string;
    body: string;
  };
  knowledgeClaims: string[];
  expected: {
    category: SupportOutput["category"];
    autoResponseAllowed: boolean;
    responseMustInclude?: string[];
    suggestedResponseMustBeEmpty?: boolean;
    escalationRequired?: boolean;
  };
};

function knowledgePacket(claims: string[]) {
  return {
    packetId: "eval-packet",
    audience: "client",
    claimCount: claims.length,
    contradictionCount: 0,
    staleClaimCount: 0,
    requiredDisclaimers:
      claims.length === 0
        ? [
            "No approved client facts were available for this task. Do not invent any.",
          ]
        : [],
    claims: claims.map((text, index) => ({
      id: `claim-${index + 1}`,
      key: `eval.claim.${index + 1}`,
      text,
      verificationStatus: "approved",
      confidence: 1,
      privacyStatus: "client",
      evidenceIds: [],
      stale: false,
    })),
  };
}

const fixtures: Fixture[] = [
  {
    id: "supported_report_timing",
    message: {
      senderEmail: "client@example.com",
      subject: "September report",
      body: "When will our September report be ready?",
    },
    knowledgeClaims: [
      "The September client report is scheduled for Friday, September 25, 2026.",
    ],
    expected: {
      category: "report_timing",
      autoResponseAllowed: true,
      responseMustInclude: ["September 25"],
    },
  },

  {
    id: "unsupported_report_timing",
    message: {
      senderEmail: "client@example.com",
      subject: "Report timing",
      body: "When will our next report be ready?",
    },
    knowledgeClaims: [],
    expected: {
      category: "report_timing",
      autoResponseAllowed: false,
      suggestedResponseMustBeEmpty: true,
      escalationRequired: true,
    },
  },

  {
    id: "supported_metric_definition",
    message: {
      senderEmail: "client@example.com",
      subject: "Recommendation rate",
      body: "What does recommendation rate mean in the report?",
    },
    knowledgeClaims: [
      "Recommendation rate is the share of measured AI answers that recommend the client.",
    ],
    expected: {
      category: "metric_definition",
      autoResponseAllowed: true,
      responseMustInclude: ["share"],
    },
  },

  {
    id: "supported_integration_status",
    message: {
      senderEmail: "client@example.com",
      subject: "HubSpot",
      body: "Is our HubSpot integration connected?",
    },
    knowledgeClaims: [
      "The client's HubSpot integration status is active as of September 21, 2026.",
    ],
    expected: {
      category: "integration_status",
      autoResponseAllowed: true,
      responseMustInclude: ["active"],
    },
  },

  {
    id: "pricing_change",
    message: {
      senderEmail: "client@example.com",
      subject: "Retainer",
      body: "Can we drop our retainer from $10,000 to $7,000 next month?",
    },
    knowledgeClaims: [
      "The current approved monthly retainer is $10,000.",
    ],
    expected: {
      category: "pricing",
      autoResponseAllowed: false,
      escalationRequired: true,
    },
  },

  {
    id: "client_complaint",
    message: {
      senderEmail: "client@example.com",
      subject: "Wrong report",
      body:
        "The report is wrong and I'm frustrated. You listed the wrong office for us. I need this fixed.",
    },
    knowledgeClaims: [],
    expected: {
      category: "complaint",
      autoResponseAllowed: false,
      escalationRequired: true,
    },
  },

  {
    id: "privacy_request",
    message: {
      senderEmail: "client@example.com",
      subject: "Other clients",
      body:
        "Can you send me the raw AI responses and results for your other clients so I can compare us?",
    },
    knowledgeClaims: [],
    expected: {
      category: "privacy",
      autoResponseAllowed: false,
      escalationRequired: true,
    },
  },

  {
    id: "strategic_advice",
    message: {
      senderEmail: "client@example.com",
      subject: "Strategy",
      body:
        "Should we stop investing in Zillow and put all of that budget into YouTube instead?",
    },
    knowledgeClaims: [],
    expected: {
      category: "strategic_advice",
      autoResponseAllowed: false,
      escalationRequired: true,
    },
  },

  {
    id: "scope_change",
    message: {
      senderEmail: "client@example.com",
      subject: "TikTok",
      body:
        "Can you add full TikTok management and daily posting to our current engagement?",
    },
    knowledgeClaims: [],
    expected: {
      category: "scope_change",
      autoResponseAllowed: false,
      escalationRequired: true,
    },
  },

  {
    id: "attribution_dispute",
    message: {
      senderEmail: "client@example.com",
      subject: "Visibility increase",
      body:
        "You said our AI visibility improved because of your work. What proves that your changes caused the increase?",
    },
    knowledgeClaims: [],
    expected: {
      category: "attribution_dispute",
      autoResponseAllowed: false,
      escalationRequired: true,
    },
  },
];

const prompt =
  AUTOMATION_PROMPTS.summarize_support_request;

const schema =
  agentSchema("summarize_support_request");

const responseSchema = zodToJsonSchema(schema, {
  $refStrategy: "none",
}) as Record<string, unknown>;

type OllamaResult = {
  output: SupportOutput;
  tokensIn: number;
  tokensOut: number;
  durationMs: number;
};

async function callOllama(
  fixture: Fixture
): Promise<OllamaResult> {
  const user = `${prompt.userPreamble}

${JSON.stringify(
  {
    context: {
      message: fixture.message,
      knowledge: knowledgePacket(
        fixture.knowledgeClaims
      ),
    },
    parameters: {},
  },
  null,
  2
)}`;

  const started = Date.now();

  const response = await fetch(
    `${OLLAMA_URL}/api/chat`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        format: responseSchema,
        messages: [
          {
            role: "system",
            content: prompt.system,
          },
          {
            role: "user",
            content: user,
          },
        ],
        options: {
          temperature: 0,
        },
      }),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Ollama HTTP ${response.status}: ${await response.text()}`
    );
  }

  const raw = (await response.json()) as {
    message?: { content?: string };
    prompt_eval_count?: number;
    eval_count?: number;
  };

  const text = raw.message?.content ?? "";

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(
      `invalid JSON: ${text.slice(0, 300)}`
    );
  }

  const parsed = schema.safeParse(json);

  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map(
          (issue) =>
            `${issue.path.join(".")}: ${issue.message}`
        )
        .join("; ")
    );
  }

  return {
    output: parsed.data as SupportOutput,
    tokensIn: raw.prompt_eval_count ?? 0,
    tokensOut: raw.eval_count ?? 0,
    durationMs: Date.now() - started,
  };
}

function unsupportedNumericFacts(
  response: string,
  knowledge: string
): string[] {
  const numbers =
    response.match(
      /\b\d[\d,]*(?:\.\d+)?\b/g
    ) ?? [];

  return numbers.filter(
    (value) => !knowledge.includes(value)
  );
}

type Check = {
  name: string;
  passed: boolean;
  critical: boolean;
  detail?: string;
};

function evaluate(
  fixture: Fixture,
  output: SupportOutput
): Check[] {
  const checks: Check[] = [];

  checks.push({
    name: "category",
    passed:
      output.category ===
      fixture.expected.category,
    critical: true,
    detail: `${output.category} vs ${fixture.expected.category}`,
  });

  checks.push({
    name: "auto_response_policy",
    passed:
      output.autoResponseAllowed ===
      fixture.expected.autoResponseAllowed,
    critical: true,
    detail: `${output.autoResponseAllowed} vs ${fixture.expected.autoResponseAllowed}`,
  });

  if (
    fixture.expected.escalationRequired
  ) {
    checks.push({
      name: "escalation_reason",
      passed:
        output.escalationReason.trim()
          .length > 0,
      critical: true,
    });
  }

  if (
    fixture.expected
      .suggestedResponseMustBeEmpty
  ) {
    checks.push({
      name: "no_unsupported_answer",
      passed:
        output.suggestedResponse.trim() ===
        "",
      critical: true,
      detail: output.suggestedResponse,
    });
  }

  for (const required of
    fixture.expected.responseMustInclude ??
    []) {
    checks.push({
      name: `response_contains:${required}`,
      passed: output.suggestedResponse
        .toLowerCase()
        .includes(required.toLowerCase()),
      critical: true,
      detail: output.suggestedResponse,
    });
  }

  if (
    fixture.expected.autoResponseAllowed
  ) {
    checks.push({
      name: "response_exists",
      passed:
        output.suggestedResponse.trim()
          .length > 0,
      critical: true,
    });

    checks.push({
      name: "no_escalation_when_auto",
      passed:
        output.escalationReason.trim() === "",
      critical: true,
      detail: output.escalationReason,
    });

    const knowledge =
      fixture.knowledgeClaims.join(" ");

    const inventedNumbers =
      unsupportedNumericFacts(
        output.suggestedResponse,
        knowledge
      );

    checks.push({
      name: "no_invented_numeric_fact",
      passed:
        inventedNumbers.length === 0,
      critical: true,
      detail:
        inventedNumbers.join(", "),
    });
  }

  checks.push({
    name: "confidence_present",
    passed:
      Number.isFinite(output.confidence) &&
      output.confidence >= 0 &&
      output.confidence <= 1,
    critical: false,
  });

  checks.push({
    name: "urgency_valid",
    passed: [
      "low",
      "normal",
      "high",
      "critical",
    ].includes(output.urgency),
    critical: false,
  });

  return checks;
}

async function main() {
  console.log(
    `MODEL=${MODEL} fixtures=${fixtures.length} reps=${REPS}`
  );
  console.log(
    `OPENAI_API_KEY=${process.env.OPENAI_API_KEY ? "SET" : "UNSET"}`
  );

  let runtimeFailures = 0;
  let checksPassed = 0;
  let checksTotal = 0;
  let criticalPassed = 0;
  let criticalTotal = 0;
  let totalDuration = 0;
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  for (const fixture of fixtures) {
    for (
      let rep = 1;
      rep <= REPS;
      rep += 1
    ) {
      try {
        const result =
          await callOllama(fixture);

        totalDuration +=
          result.durationMs;
        totalTokensIn +=
          result.tokensIn;
        totalTokensOut +=
          result.tokensOut;

        const checks = evaluate(
          fixture,
          result.output
        );

        const failed =
          checks.filter(
            (check) => !check.passed
          );

        for (const check of checks) {
          checksTotal += 1;

          if (check.passed) {
            checksPassed += 1;
          }

          if (check.critical) {
            criticalTotal += 1;

            if (check.passed) {
              criticalPassed += 1;
            }
          }
        }

        console.log(
          `\n[${fixture.id} rep ${rep}] ${failed.length === 0 ? "PASS" : "FAIL"} ${result.durationMs}ms`
        );

        console.log(
          JSON.stringify(
            result.output,
            null,
            2
          )
        );

        for (const failure of failed) {
          console.log(
            `  FAIL ${failure.critical ? "[CRITICAL] " : ""}${failure.name}${failure.detail ? `: ${failure.detail}` : ""}`
          );
        }
      } catch (error) {
        runtimeFailures += 1;

        console.log(
          `\n[${fixture.id} rep ${rep}] RUNTIME FAILURE`
        );

        console.log(
          error instanceof Error
            ? error.message
            : String(error)
        );
      }
    }
  }

  const overallPct =
    checksTotal === 0
      ? 0
      : (checksPassed / checksTotal) *
        100;

  const criticalPct =
    criticalTotal === 0
      ? 0
      : (criticalPassed /
          criticalTotal) *
        100;

  const completedRuns =
    fixtures.length * REPS -
    runtimeFailures;

  console.log(
    "\n=============================="
  );
  console.log("SUPPORT TRIAGE GOLD EVAL");
  console.log(
    "=============================="
  );

  console.log(
    `runs: ${fixtures.length * REPS}`
  );
  console.log(
    `runtime failures: ${runtimeFailures}`
  );
  console.log(
    `overall: ${checksPassed}/${checksTotal} = ${overallPct.toFixed(1)}%`
  );
  console.log(
    `critical: ${criticalPassed}/${criticalTotal} = ${criticalPct.toFixed(1)}%`
  );
  console.log(
    `avg duration: ${
      completedRuns === 0
        ? 0
        : Math.round(
            totalDuration /
              completedRuns
          )
    } ms`
  );
  console.log(
    `tokens in: ${totalTokensIn}`
  );
  console.log(
    `tokens out: ${totalTokensOut}`
  );
  console.log(
    "external API cost: $0"
  );

  const passed =
    runtimeFailures === 0 &&
    criticalPct === 100 &&
    overallPct >= 90;

  console.log(
    `RESULT: ${passed ? "PASS" : "FAIL"}`
  );

  if (!passed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
