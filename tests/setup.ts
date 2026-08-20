import * as dotenv from "dotenv";

dotenv.config();

// Integration tests must never touch the dev database
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}

// Tests run in dev-auth mode regardless of how the operator's .env is set.
// The suite must not depend on an identity provider being reachable, and once
// AUTH_MODE=supabase is switched on for real work, inheriting it here drags
// `server-only` modules into the test environment and fails the run for a
// reason that has nothing to do with the code under test. CI sets this
// explicitly; local .env files should not be able to contradict it.
process.env.AUTH_MODE = "dev";

// Publish-time source-link liveness (spec 065) must never touch the network
// from the suite; tests that exercise it inject a stub fetch, which takes
// precedence over this kill-switch.
process.env.QA_SOURCE_LINK_CHECKS = "off";

// APP_URL entered the operator's .env on 2026-08-20 (audit links from local
// scripts). Tests were all written against an UNSET default — fail-closed
// link refusals, origin fallbacks — and the ones that need a value set it
// themselves. Same rule as AUTH_MODE: the local .env must not leak in.
delete process.env.APP_URL;

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
