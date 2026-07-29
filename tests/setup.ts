import * as dotenv from "dotenv";

dotenv.config();

// Integration tests must never touch the dev database
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Tests must never spend tokens or depend on a provider being reachable
// (docs/09). Stripping the keys also pins the parse pipeline to the
// deterministic heuristic classifier; LLM paths are exercised by injecting
// a caller (see tests/unit/classify-llm.test.ts).
for (const key of [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GOOGLE_API_KEY",
  "PERPLEXITY_API_KEY",
]) {
  delete process.env[key];
}
