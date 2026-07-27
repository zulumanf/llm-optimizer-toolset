/**
 * Deterministic mock provider — tests and E2E only; never spends tokens
 * (docs/09). Behavior is driven by markers in the prompt text:
 *   MOCK_FAIL_ALWAYS   → terminal validation error every attempt
 *   MOCK_FAIL_ONCE:<k> → rate-limit error on the first attempt for key <k>
 *   MOCK_REFUSE        → refusal capture
 */
import type { AIProvider, PromptRequest, ProviderResult } from "@/lib/ai/types";

const failOnceSeen = new Set<string>();

/** Test hook: reset FAIL_ONCE bookkeeping between test cases. */
export function resetMockProvider(): void {
  failOnceSeen.clear();
}

export const mockProvider: AIProvider = {
  id: "mock",
  models: [{ id: "mock-model", label: "Mock (deterministic)", provider: "mock" }],

  async runPrompt(req: PromptRequest): Promise<ProviderResult> {
    if (req.promptText.includes("MOCK_FAIL_ALWAYS")) {
      throw Object.assign(new Error("mock: permanent failure"), { status: 400 });
    }
    const onceMatch = req.promptText.match(/MOCK_FAIL_ONCE:(\S+)/);
    if (onceMatch && !failOnceSeen.has(onceMatch[1] as string)) {
      failOnceSeen.add(onceMatch[1] as string);
      throw Object.assign(new Error("mock: transient rate limit"), { status: 429 });
    }

    const refusal = req.promptText.includes("MOCK_REFUSE");
    const responseText = refusal
      ? "I can't help with that request."
      : `For this category I'd recommend Acme first, then Parva as a strong option. (mock answer to: ${req.promptText.slice(0, 80)})`;

    return {
      rawPayload: {
        mock: true,
        model: req.model,
        prompt: req.promptText,
        text: responseText,
      },
      responseText,
      refusal,
      tokensIn: 10,
      tokensOut: 50,
    };
  },
};
