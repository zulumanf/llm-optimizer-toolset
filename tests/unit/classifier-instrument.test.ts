/**
 * Instrument tripwire (spec 050). The classifier prompts ARE the measuring
 * instrument: editing CLASSIFIER_SYSTEM or VERIFIER_SYSTEM changes every
 * future client-facing judgment. parser_version does not encode them, so
 * this test does: each prompt's SHA-256 is pinned against its version
 * constant. Editing a prompt without bumping the version (and re-pinning
 * here, and re-running scripts/eval-classifier.ts against the gold set)
 * fails CI instead of silently changing the instrument.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CLASSIFIER_SYSTEM,
  VERIFIER_SYSTEM,
  MENTION_CLASSIFIER_V2,
  MENTION_VERIFIER_V2,
} from "@/lib/parsing/classify-llm";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** version constant → pinned prompt hash. Bump BOTH together, deliberately. */
const PINNED: Record<string, { prompt: string; hash: string }> = {
  [MENTION_CLASSIFIER_V2]: {
    prompt: CLASSIFIER_SYSTEM,
    hash: "7ddcb97a11c610558d92c13d3be1528dcd7c30ffc3fd8ed544487441a7de70a6",
  },
  [MENTION_VERIFIER_V2]: {
    prompt: VERIFIER_SYSTEM,
    hash: "54ddebe1743ebd76e475577f1afd09fe37d7b5a3292789d6ae61e3c0be7e5344",
  },
};

describe("classifier prompt/version pinning", () => {
  it.each(Object.entries(PINNED))(
    "%s matches its pinned prompt hash",
    (version, { prompt, hash }) => {
      expect(
        sha256(prompt),
        `The prompt behind "${version}" changed. This is a new measuring ` +
          `instrument: bump the version constant, update the pinned hash, and ` +
          `run scripts/eval-classifier.ts to prove the new instrument against ` +
          `the gold set before it ships (spec 050).`
      ).toBe(hash);
    }
  );

  it("versions are distinct — the verifier is a different instrument", () => {
    expect(MENTION_CLASSIFIER_V2).not.toBe(MENTION_VERIFIER_V2);
  });
});
