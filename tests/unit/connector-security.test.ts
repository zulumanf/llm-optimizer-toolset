/**
 * Security unit tests for the connector layer.
 *
 * These test the claims the specs make about credentials, not the happy path:
 * that a ciphertext cannot be moved between connections, that no accessor
 * outside the credential boundary can read a secret, that redaction survives
 * nesting, and that test mode cannot execute a consequential capability.
 *
 * The import-boundary test is deliberately a source-level assertion. "An agent
 * cannot read a token" is a claim about the shape of the codebase, and the only
 * way to keep it true as the codebase grows is to test the shape.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import {
  CURRENT_KEY_VERSION,
  encryptionAvailable,
  open,
  redactSecrets,
  redactString,
  safeEqual,
  seal,
  REDACTED,
} from "@/lib/security/envelope";
import { ClassifiedError } from "@/lib/errors";
import {
  CONSEQUENTIAL_CAPABILITIES,
  isConsequential,
  isMutating,
  type ConnectorCapability,
} from "@/lib/connectors/types";
import {
  connectorStatusCounts,
  getConnector,
  hasConnector,
  listConnectors,
  providersFor,
} from "@/lib/connectors/registry";
import { capabilityAllowed, assertNotTestMode } from "@/lib/automation/testmode";

const ROOT = join(__dirname, "..", "..");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

describe("envelope encryption", () => {
  let previousKey: string | undefined;

  beforeAll(() => {
    previousKey = process.env.AUTOMATION_CREDENTIAL_KEY;
    process.env.AUTOMATION_CREDENTIAL_KEY = TEST_KEY;
  });

  afterAll(() => {
    if (previousKey === undefined) delete process.env.AUTOMATION_CREDENTIAL_KEY;
    else process.env.AUTOMATION_CREDENTIAL_KEY = previousKey;
  });

  it("round-trips a secret", () => {
    const sealed = seal("sk-live-abc123", "connection-1");
    expect(open(sealed, "connection-1")).toBe("sk-live-abc123");
    expect(sealed.keyVersion).toBe(CURRENT_KEY_VERSION);
  });

  it("produces a different ciphertext each time (fresh IV)", () => {
    const a = seal("same-secret", "connection-1");
    const b = seal("same-secret", "connection-1");
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.iv.equals(b.iv)).toBe(false);
    // Both still decrypt.
    expect(open(a, "connection-1")).toBe("same-secret");
    expect(open(b, "connection-1")).toBe("same-secret");
  });

  it("refuses to decrypt a ciphertext moved to another connection", () => {
    const sealed = seal("sk-live-abc123", "connection-1");
    // This is the attack the AAD exists to stop: copy a credential row onto
    // another client's connection and use it.
    expect(() => open(sealed, "connection-2")).toThrow(ClassifiedError);
    expect(() => open(sealed, "connection-2")).toThrow(/could not be decrypted/);
  });

  it("refuses a tampered ciphertext", () => {
    const sealed = seal("sk-live-abc123", "connection-1");
    sealed.ciphertext[0] = sealed.ciphertext[0]! ^ 0xff;
    expect(() => open(sealed, "connection-1")).toThrow(ClassifiedError);
  });

  it("refuses a tampered auth tag", () => {
    const sealed = seal("sk-live-abc123", "connection-1");
    sealed.authTag[0] = sealed.authTag[0]! ^ 0xff;
    expect(() => open(sealed, "connection-1")).toThrow(ClassifiedError);
  });

  it("gives an opaque error rather than a decryption oracle", () => {
    const sealed = seal("secret", "connection-1");
    let wrongOwner = "";
    let tampered = "";
    try {
      open(sealed, "connection-2");
    } catch (err) {
      wrongOwner = (err as Error).message;
    }
    const other = seal("secret", "connection-1");
    other.ciphertext[0] = other.ciphertext[0]! ^ 0xff;
    try {
      open(other, "connection-1");
    } catch (err) {
      tampered = (err as Error).message;
    }
    // Distinguishing "wrong owner" from "tampered" would leak information.
    expect(wrongOwner).toBe(tampered);
  });

  it("reports availability honestly", () => {
    expect(encryptionAvailable()).toBe(true);
  });
});

describe("envelope encryption without a key", () => {
  it("fails closed rather than storing plaintext", () => {
    const previous = process.env.AUTOMATION_CREDENTIAL_KEY;
    delete process.env.AUTOMATION_CREDENTIAL_KEY;
    try {
      expect(encryptionAvailable()).toBe(false);
      // A system that stores secrets in the clear when misconfigured is worse
      // than one that refuses to work.
      expect(() => seal("secret", "connection-1")).toThrow(/AUTOMATION_CREDENTIAL_KEY/);
    } finally {
      if (previous !== undefined) process.env.AUTOMATION_CREDENTIAL_KEY = previous;
    }
  });

  it("rejects a key of the wrong length", () => {
    const previous = process.env.AUTOMATION_CREDENTIAL_KEY;
    process.env.AUTOMATION_CREDENTIAL_KEY = Buffer.alloc(16, 1).toString("base64");
    try {
      expect(() => seal("secret", "connection-1")).toThrow(/must decode to 32 bytes/);
    } finally {
      if (previous === undefined) delete process.env.AUTOMATION_CREDENTIAL_KEY;
      else process.env.AUTOMATION_CREDENTIAL_KEY = previous;
    }
  });
});

describe("constant-time comparison", () => {
  it("matches equal strings", () => {
    expect(safeEqual("abcdef", "abcdef")).toBe(true);
  });

  it("rejects different strings of equal length", () => {
    expect(safeEqual("abcdef", "abcdeg")).toBe(false);
  });

  it("rejects different lengths without throwing", () => {
    expect(safeEqual("abc", "abcdef")).toBe(false);
    expect(safeEqual("", "a")).toBe(false);
  });
});

describe("redaction", () => {
  it("redacts token-shaped substrings", () => {
    expect(redactString("using sk-live-abcdefghijklmnop")).toContain(REDACTED);
    expect(redactString("using sk-live-abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(redactString("Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9")).toContain(REDACTED);
    expect(redactString("xoxb-1234567890-abcdefghijklmn")).toContain(REDACTED);
  });

  it("redacts long opaque strings", () => {
    const token = "A".repeat(48);
    expect(redactString(`token=${token}`)).not.toContain(token);
  });

  it("leaves ordinary prose alone", () => {
    const message = "The GA4 property returned 47 rows for the period.";
    expect(redactString(message)).toBe(message);
  });

  it("redacts secret-named keys wholesale", () => {
    const redacted = redactSecrets({
      authorization: "Bearer abc",
      api_key: "k-1",
      accessToken: "t-1",
      client_secret: "s-1",
      password: "hunter2",
      signature: "sig",
      propertyId: "12345",
    });
    expect(redacted.authorization).toBe(REDACTED);
    expect(redacted.api_key).toBe(REDACTED);
    expect(redacted.accessToken).toBe(REDACTED);
    expect(redacted.client_secret).toBe(REDACTED);
    expect(redacted.password).toBe(REDACTED);
    expect(redacted.signature).toBe(REDACTED);
    // A non-secret value survives, or the redactor would be useless.
    expect(redacted.propertyId).toBe("12345");
  });

  it("redacts through nesting and arrays", () => {
    const redacted = redactSecrets({
      level1: {
        level2: [{ refresh_token: "r-1" }, { safe: "value" }],
        note: "sk-live-abcdefghijklmnopqrst",
      },
    }) as { level1: { level2: [{ refresh_token: string }, { safe: string }]; note: string } };
    expect(redacted.level1.level2[0].refresh_token).toBe(REDACTED);
    expect(redacted.level1.level2[1].safe).toBe("value");
    expect(redacted.level1.note).toContain(REDACTED);
  });

  it("redacts a Buffer wholesale", () => {
    expect(redactSecrets({ ciphertext: Buffer.from("secret") }).ciphertext).toBe(REDACTED);
  });

  it("bounds recursion rather than hanging on a cycle-shaped structure", () => {
    let deep: Record<string, unknown> = { value: "sk-live-abcdefghijklmnop" };
    for (let i = 0; i < 20; i += 1) deep = { nested: deep };
    // Terminates, and the terminal marker is a redaction rather than raw data.
    expect(() => redactSecrets(deep)).not.toThrow();
  });
});

describe("the credential import boundary", () => {
  /**
   * `db/connectors.ts` exposes exactly one accessor that returns ciphertext.
   * If a second appears, or if a module outside the credential boundary starts
   * importing it, this test fails — which is the point.
   */
  it("has exactly one ciphertext accessor in db/connectors.ts", () => {
    const source = readFileSync(join(ROOT, "db", "connectors.ts"), "utf8");
    const exported = [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    const ciphertextAccessors = exported.filter((name) =>
      /credential/i.test(name) && !/upsert|has/i.test(name)
    );
    expect(ciphertextAccessors).toEqual(["credentialMaterial"]);
  });

  it("is imported only by the credential module", () => {
    const files = [
      "lib/connectors/execute.ts",
      "lib/connectors/health.ts",
      "lib/connectors/registry.ts",
      "lib/connectors/mapping.ts",
      "lib/automation/nodes/integration.ts",
      "lib/automation/nodes/agent.ts",
      "lib/automation/nodes/domain.ts",
      "lib/automation/runtime.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, `${file} must not read credential ciphertext`).not.toContain(
        "credentialMaterial"
      );
    }
    // The boundary module is the one place that may.
    const boundary = readFileSync(join(ROOT, "lib", "connectors", "credentials.ts"), "utf8");
    expect(boundary).toContain("credentialMaterial");
  });

  it("keeps credential columns out of the shared connection selector", () => {
    const source = readFileSync(join(ROOT, "db", "connectors.ts"), "utf8");
    const selector = source.slice(
      source.indexOf("const CONNECTION_COLUMNS"),
      source.indexOf("function toConnection")
    );
    for (const column of ["ciphertext", "auth_tag", "refresh_", "iv"]) {
      expect(selector, `CONNECTION_COLUMNS must not select ${column}`).not.toContain(column);
    }
  });

  it("gives node handlers no way to reach a secret", () => {
    // NodeContext is the only thing a handler receives. If it ever grows a
    // secret accessor, this fails.
    const types = readFileSync(join(ROOT, "lib", "workflow", "types.ts"), "utf8");
    const context = types.slice(
      types.indexOf("export interface NodeContext"),
      types.indexOf("export type NodeOutcome")
    );
    expect(context).not.toMatch(/secret|token|credential|sql|connection/i);
  });

  it("keeps vendor SDKs out of everything but the adapters", () => {
    const files = [
      "lib/connectors/execute.ts",
      "lib/connectors/http.ts",
      "lib/automation/nodes/integration.ts",
      "lib/automation/runtime.ts",
    ];
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), "utf8");
      for (const vendor of ["@hubspot", "stripe/", "googleapis", "@slack"]) {
        expect(source, `${file} must not import ${vendor}`).not.toContain(vendor);
      }
    }
  });
});

describe("consequential capability classification", () => {
  it("marks every irreversible external action consequential", () => {
    expect(isConsequential("email.send_approved_message")).toBe(true);
    expect(isConsequential("cms.publish_approved_asset")).toBe(true);
    expect(isConsequential("billing.create_invoice")).toBe(true);
    expect(isConsequential("billing.send_reminder")).toBe(true);
    expect(isConsequential("notification.send_client")).toBe(true);
  });

  it("does not mark reads consequential", () => {
    expect(isConsequential("analytics.fetch_sessions")).toBe(false);
    expect(isConsequential("crm.fetch_contacts")).toBe(false);
    expect(isConsequential("cms.fetch_public_page")).toBe(false);
  });

  it("treats every consequential capability as mutating too", () => {
    for (const capability of CONSEQUENTIAL_CAPABILITIES) {
      expect(isMutating(capability)).toBe(true);
    }
  });

  it("marks external mutations mutating but not consequential", () => {
    expect(isMutating("crm.create_contact")).toBe(true);
    expect(isConsequential("crm.create_contact")).toBe(false);
    expect(isMutating("cms.create_draft")).toBe(true);
    expect(isConsequential("cms.create_draft")).toBe(false);
  });
});

describe("test mode guards", () => {
  const testRun = {
    mode: "test" as const,
    fixtures: { connectorResponses: {}, agentResponses: {} },
    allowCrmWrites: false,
  };
  const liveRun = { ...testRun, mode: "live" as const };

  it("refuses every consequential capability in test mode", () => {
    for (const capability of CONSEQUENTIAL_CAPABILITIES) {
      const verdict = capabilityAllowed(testRun, capability);
      expect(verdict.allowed, `${capability} must be refused in test mode`).toBe(false);
      expect(verdict.reason).toContain("consequential");
    }
  });

  it("allows reads in test mode, served from fixtures", () => {
    const verdict = capabilityAllowed(testRun, "analytics.fetch_sessions");
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toContain("fixtures");
  });

  it("allows everything in a live run", () => {
    for (const capability of CONSEQUENTIAL_CAPABILITIES) {
      expect(capabilityAllowed(liveRun, capability).allowed).toBe(true);
    }
  });

  it("throws on an explicit assertion in test mode", () => {
    expect(() => assertNotTestMode(testRun, "send the email")).toThrow(ClassifiedError);
    expect(() => assertNotTestMode(testRun, "send the email")).toThrow(/cannot run in test mode/);
    expect(() => assertNotTestMode(liveRun, "send the email")).not.toThrow();
  });
});

describe("connector registry", () => {
  it("resolves a provider by name", () => {
    expect(getConnector("ga4").provider).toBe("ga4");
    expect(hasConnector("hubspot")).toBe(true);
    expect(hasConnector("nonexistent")).toBe(false);
  });

  it("throws a useful error for an unknown provider", () => {
    expect(() => getConnector("nope")).toThrow(/No connector adapter/);
    expect(() => getConnector("nope")).toThrow(/Registered:/);
  });

  it("prefers verified adapters when several implement a capability", () => {
    const providers = providersFor("crm.fetch_contacts");
    expect(providers.length).toBeGreaterThan(1);
    // fixture/csv/manual are verified and must rank ahead of the unverified ones.
    const first = getConnector(providers[0]!);
    expect(first.status).toBe("verified");
  });

  it("labels adapter status honestly and never inflates the verified count", () => {
    const counts = connectorStatusCounts();
    expect(counts.verified).toBeGreaterThan(0);
    expect(counts.implemented_unverified).toBeGreaterThan(0);
    expect(counts.contract_only).toBeGreaterThan(0);

    // Anything talking to a real third party has NOT been run here, and must
    // not claim otherwise.
    for (const connector of listConnectors()) {
      const isLocal = ["fixture", "csv", "manual", "internal_notification", "local_file_store"].includes(
        connector.provider
      );
      if (!isLocal) {
        expect(connector.status, `${connector.provider} must not claim verified`).not.toBe(
          "verified"
        );
      }
    }
  });

  it("requires an unverified adapter to state what remains", () => {
    for (const connector of listConnectors()) {
      if (connector.status !== "verified") {
        expect(
          connector.outstandingWork.length,
          `${connector.provider} must document outstanding work`
        ).toBeGreaterThan(0);
      }
    }
  });

  it("declares config schemas for every adapter", () => {
    for (const connector of listConnectors()) {
      expect(connector.configSchema, `${connector.provider} needs a config schema`).toBeDefined();
      expect(connector.capabilities.length, `${connector.provider} needs capabilities`).toBeGreaterThan(0);
    }
  });

  it("has an adapter for every capability a shipped workflow requires", async () => {
    const { AUTOMATION_WORKFLOWS } = await import("@/lib/automation/workflows");
    const required = new Set<ConnectorCapability>();
    for (const workflow of AUTOMATION_WORKFLOWS) {
      for (const capability of workflow.requiredConnectors) required.add(capability);
    }
    for (const capability of required) {
      expect(providersFor(capability).length, `no adapter for ${capability}`).toBeGreaterThan(0);
    }
  });
});

describe("connectorFetch redaction vs the token-refresh exception", () => {
  const tokenResponse = () =>
    new Response(
      JSON.stringify({
        access_token: "ya29.a0AfB_byC1234567890abcdefghijklmnopqrstuvwxyz",
        refresh_token: "1//0gABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890abcdefg",
        expires_in: 3599,
        token_type: "Bearer",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );

  it("redacts token-like response fields by default", async () => {
    const { connectorFetch } = await import("@/lib/connectors/http");
    const res = await connectorFetch(
      { url: "https://oauth2.googleapis.com/token", method: "POST", form: { a: "b" } },
      { provider: "gmail", capability: "email.send_approved_message", fetchImpl: async () => tokenResponse() }
    );
    const data = res.data as Record<string, unknown>;
    expect(data.access_token).toBe("[redacted]");
  });

  it("rawSecrets returns the credential intact — the live failure was '[redacted]' stored and replayed as a bearer token", async () => {
    const { connectorFetch } = await import("@/lib/connectors/http");
    const res = await connectorFetch(
      {
        url: "https://oauth2.googleapis.com/token",
        method: "POST",
        form: { a: "b" },
        rawSecrets: true,
      },
      { provider: "gmail", capability: "email.send_approved_message", fetchImpl: async () => tokenResponse() }
    );
    const data = res.data as Record<string, unknown>;
    expect(data.access_token).toContain("ya29.");
    expect(data.access_token).not.toContain("redacted");
  });

  it("the credential store refuses the redaction placeholder outright", async () => {
    const { storeCredential } = await import("@/lib/connectors/credentials");
    await expect(
      storeCredential({
        connectionId: "00000000-0000-4000-8000-00000000c0de",
        kind: "oauth2",
        secret: "[redacted]",
        userId: "00000000-0000-4000-8000-000000000001",
      })
    ).rejects.toThrow(/redacted placeholder/);
  });
});
