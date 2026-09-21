import { z } from "zod";
import { runAgent } from "../lib/ai/agent";
import { AUTOMATION_PROMPTS } from "../lib/automation/prompts";
import { agentSchema } from "../lib/automation/nodes/agent";
import { LOCAL_INTERNAL_TARGETS } from "../lib/ai/internal/registry";
import { sql } from "../db/client";

type MeetingOutput = {
  decisions: Array<{
    summary: string;
    owner: string;
  }>;
  actionItems: Array<{
    summary: string;
    owner: string;
    dueDate: string;
  }>;
  unresolvedQuestions: string[];
  relationshipNotes: string[];
  containsSensitiveContent: boolean;
  confidence: number;
};

type Check = {
  name: string;
  critical: boolean;
  pass: boolean;
};

type Fixture = {
  id: string;
  notes: string;

  sensitive: boolean;

  expectedOwner?: string;
  allOwnersEmpty?: boolean;

  expectedDueDate?: string;
  allDueDatesEmpty?: boolean;

  decisionKeyword?: string;
  questionKeyword?: string;

  expectedActionCount?: number;
};

const fixtures: Fixture[] = [
  {
    id: "decision-owner-no-due-date",
    notes: `
Decision: launch the Jersey City audit on Tuesday.

Maria will export the prospect list.
No due date was set for Maria's export.

Open question:
Which ten teams should be contacted first?
`,
    sensitive: false,
    expectedOwner: "Maria",
    allDueDatesEmpty: true,
    decisionKeyword: "launch",
    questionKeyword: "ten",
    expectedActionCount: 1,
  },

  {
    id: "unassigned-action",
    notes: `
Action item:
Update the landing page headline.

Nobody was assigned to own it.
No deadline was set.
`,
    sensitive: false,
    allOwnersEmpty: true,
    allDueDatesEmpty: true,
    expectedActionCount: 1,
  },

  {
    id: "pricing-dispute",
    notes: `
The client disputed the $10,000 monthly fee.

Francisco agreed to send a revised scope by Friday.

Open question:
Will the client accept the revised scope?
`,
    sensitive: true,
    expectedOwner: "Francisco",
    expectedDueDate: "Friday",
    questionKeyword: "accept",
    expectedActionCount: 1,
  },

  {
    id: "legal-matter",
    notes: `
Legal counsel said the contract language needs review.

Priya will send the clause to counsel tomorrow.
`,
    sensitive: true,
    expectedOwner: "Priya",
    expectedDueDate: "tomorrow",
    expectedActionCount: 1,
  },

  {
    id: "client-complaint",
    notes: `
The client complained that the report overstated their visibility.

Alex will compare the report with the source data.
No due date was set.
`,
    sensitive: true,
    expectedOwner: "Alex",
    allDueDatesEmpty: true,
    expectedActionCount: 1,
  },

  {
    id: "confidential-transaction",
    notes: `
Confidential transaction detail:
The seller accepted a $2.4M offer at 12 Main Street.

Jordan will remove the address from the draft before sharing.
No deadline was set.
`,
    sensitive: true,
    expectedOwner: "Jordan",
    allDueDatesEmpty: true,
    expectedActionCount: 1,
  },

  {
    id: "open-question-no-action",
    notes: `
The team discussed whether to expand to Savannah.

No decision was made.

Open question:
Do we have enough prospect data for Savannah?

No actions were assigned.
`,
    sensitive: false,
    allOwnersEmpty: true,
    allDueDatesEmpty: true,
    questionKeyword: "Savannah",
    expectedActionCount: 0,
  },

  {
    id: "informational-only",
    notes: `
The weekly benchmark finished.

Results will be reviewed at the next meeting.

No decisions were made.
No actions were assigned.
There were no open questions.
`,
    sensitive: false,
    allOwnersEmpty: true,
    allDueDatesEmpty: true,
    expectedActionCount: 0,
  },
];

const prompt = AUTOMATION_PROMPTS.summarize_meeting;

const schema = agentSchema(
  "summarize_meeting"
) as z.ZodType<MeetingOutput, z.ZodTypeDef, unknown>;

function includesIgnoreCase(
  value: string,
  expected: string
): boolean {
  return value
    .toLowerCase()
    .includes(expected.toLowerCase());
}

function score(
  output: MeetingOutput,
  fixture: Fixture
): Check[] {
  const checks: Check[] = [];

  checks.push({
    name: "sensitive-content classification",
    critical: true,
    pass:
      output.containsSensitiveContent ===
      fixture.sensitive,
  });

  if (fixture.expectedOwner) {
    checks.push({
      name: "explicit owner captured",
      critical: true,
      pass: output.actionItems.some((item) =>
        includesIgnoreCase(
          item.owner,
          fixture.expectedOwner!
        )
      ),
    });
  }

  if (fixture.allOwnersEmpty) {
    checks.push({
      name: "no invented owner",
      critical: true,
      pass: output.actionItems.every(
        (item) => item.owner.trim() === ""
      ),
    });
  }

  if (fixture.expectedDueDate) {
    checks.push({
      name: "explicit due date captured",
      critical: true,
      pass: output.actionItems.some((item) =>
        includesIgnoreCase(
          item.dueDate,
          fixture.expectedDueDate!
        )
      ),
    });
  }

  if (fixture.allDueDatesEmpty) {
    checks.push({
      name: "no invented due date",
      critical: true,
      pass: output.actionItems.every(
        (item) => item.dueDate.trim() === ""
      ),
    });
  }

  if (fixture.decisionKeyword) {
    checks.push({
      name: "decision captured",
      critical: false,
      pass: output.decisions.some((decision) =>
        includesIgnoreCase(
          decision.summary,
          fixture.decisionKeyword!
        )
      ),
    });
  }

  if (fixture.questionKeyword) {
    checks.push({
      name: "open question captured",
      critical: false,
      pass: output.unresolvedQuestions.some(
        (question) =>
          includesIgnoreCase(
            question,
            fixture.questionKeyword!
          )
      ),
    });
  }

  if (
    fixture.expectedActionCount !== undefined
  ) {
    checks.push({
      name: "correct action count",
      critical: false,
      pass:
        output.actionItems.length ===
        fixture.expectedActionCount,
    });
  }

  return checks;
}

async function ledger(agentVersion: string) {
  const rows = await sql`
    select
      model,
      backend,
      tokens_in,
      tokens_out,
      duration_ms,
      cost_micro_usd,
      attempts,
      success
    from llm_calls
    where agent_version = ${agentVersion}
    order by called_at desc
    limit 1
  `;

  return rows[0];
}

async function main() {
  const target = LOCAL_INTERNAL_TARGETS.cheap;

  if (
    target.backend !== "ollama" ||
    target.model !== "qwen3:8b"
  ) {
    throw new Error(
      `Unexpected cheap route: ${target.backend}/${target.model}`
    );
  }

  console.log(
    "\n=== SPEC 142 OPEN-WEIGHT GOLD EVAL ==="
  );

  console.log("BACKEND:", target.backend);
  console.log("MODEL:", target.model);
  console.log("FIXTURES:", fixtures.length);
  console.log("REPETITIONS PER FIXTURE: 2");
  console.log(
    "OPENAI IS NOT PART OF THIS EVALUATION"
  );

  let passed = 0;
  let total = 0;

  let criticalPassed = 0;
  let criticalTotal = 0;

  let runtimeFailures = 0;

  let durationTotal = 0;
  let successfulRuns = 0;

  let tokensIn = 0;
  let tokensOut = 0;

  for (const fixture of fixtures) {
    for (let repetition = 1; repetition <= 2; repetition += 1) {
      console.log(
        `\n--- ${fixture.id} | run ${repetition}/2 ---`
      );

      const agentVersion =
        `spec142-gold-${fixture.id}-r${repetition}-${Date.now()}`;

      try {
        const result = await runAgent({
          agentVersion,
          system: prompt.system,
          user: `${prompt.userPreamble}

${JSON.stringify(
  {
    context: {
      meetingNotes: fixture.notes,
    },
    parameters: {},
  },
  null,
  2
)}`,
          schema,
          model: target.model,
          backend: target.backend,
          purpose:
            "spec142_summarize_meeting_gold_eval",
        });

        const output = result.output;
        const checks = score(
          output,
          fixture
        );

        for (const check of checks) {
          total += 1;

          if (check.pass) {
            passed += 1;
          }

          if (check.critical) {
            criticalTotal += 1;

            if (check.pass) {
              criticalPassed += 1;
            }
          }

          console.log(
            `${check.pass ? "PASS" : "FAIL"}${
              check.critical
                ? " [CRITICAL]"
                : ""
            } ${check.name}`
          );
        }

        if (checks.some((check) => !check.pass)) {
          console.log(
            "OUTPUT:",
            JSON.stringify(output, null, 2)
          );
        }

        const row =
          await ledger(agentVersion);

        if (!row) {
          throw new Error(
            "ledger row missing"
          );
        }

        console.log(
          "PROVENANCE:",
          `${row.backend}/${row.model}`
        );

        console.log(
          "DURATION:",
          `${row.durationMs} ms`
        );

        console.log(
          "TOKENS:",
          `${row.tokensIn} in / ${row.tokensOut} out`
        );

        console.log(
          "EXTERNAL API COST:",
          `$${(
            Number(row.costMicroUsd) /
            1_000_000
          ).toFixed(6)}`
        );

        if (row.backend !== "ollama") {
          throw new Error(
            "non-Ollama backend detected"
          );
        }

        if (row.model !== "qwen3:8b") {
          throw new Error(
            "unexpected model detected"
          );
        }

        if (
          Number(row.costMicroUsd) !== 0
        ) {
          throw new Error(
            "local call recorded external API cost"
          );
        }

        durationTotal += Number(
          row.durationMs
        );

        tokensIn += Number(
          row.tokensIn
        );

        tokensOut += Number(
          row.tokensOut
        );

        successfulRuns += 1;
      } catch (error) {
        runtimeFailures += 1;

        console.log(
          "RUNTIME/SCHEMA FAILURE:",
          error instanceof Error
            ? error.message
            : error
        );
      }
    }
  }

  const overallPct =
    total === 0
      ? 0
      : (passed / total) * 100;

  const criticalPct =
    criticalTotal === 0
      ? 0
      : (criticalPassed /
          criticalTotal) *
        100;

  const avgDurationMs =
    successfulRuns === 0
      ? 0
      : Math.round(
          durationTotal /
            successfulRuns
        );

  const gatePassed =
    runtimeFailures === 0 &&
    criticalPct === 100 &&
    overallPct >= 90;

  console.log(
    "\n================ RESULTS ================"
  );

  console.table([
    {
      backend: target.backend,
      model: target.model,
      runs: fixtures.length * 2,
      runtimeFailures,
      overall:
        `${passed}/${total} (${overallPct.toFixed(
          1
        )}%)`,
      critical:
        `${criticalPassed}/${criticalTotal} (${criticalPct.toFixed(
          1
        )}%)`,
      avgDurationMs,
      tokensIn,
      tokensOut,
      externalApiCostUsd: 0,
    },
  ]);

  console.log(
    "\nPROMOTION GATE:"
  );

  console.log(
    "1. Zero runtime/schema failures"
  );

  console.log(
    "2. 100% critical checks"
  );

  console.log(
    "3. >=90% overall checks"
  );

  console.log(
    `\nRESULT: ${
      gatePassed
        ? "PASS"
        : "FAIL"
    }`
  );

  console.log(
    "\nNo production routing was changed."
  );

  await sql.end();

  if (!gatePassed) {
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  console.error(error);

  try {
    await sql.end();
  } catch {}

  process.exit(1);
});
