/**
 * Durable artifacts against a REAL S3-compatible server (release 151).
 * Runs only when S3_TEST_ENDPOINT is set (CI skips it), e.g.:
 *
 *   docker run -d --rm --name rf-s3-test -p 127.0.0.1:9310:8333 \
 *     -v $PWD/s3.json:/etc/s3.json:ro chrislusf/seaweedfs server -s3 -s3.config=/etc/s3.json
 *   S3_TEST_ENDPOINT=http://127.0.0.1:9310 S3_TEST_ACCESS_KEY=… S3_TEST_SECRET_KEY=… npx vitest run tests/integration/object-store-s3.test.ts
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

const ENDPOINT = process.env.S3_TEST_ENDPOINT;
const ACCESS = process.env.S3_TEST_ACCESS_KEY ?? "";
const SECRET = process.env.S3_TEST_SECRET_KEY ?? "";
const BUCKET = `rf-test-${Date.now()}`;

describe.skipIf(!ENDPOINT)("artifact storage against a real S3-compatible server", () => {
  const saved: Record<string, string | undefined> = {};
  let store: typeof import("@/lib/storage/object-store");
  let ca: typeof import("@/lib/storage/content-addressed");

  const setEnv = (vars: Record<string, string>) => {
    for (const [k, v] of Object.entries(vars)) {
      if (!(k in saved)) saved[k] = process.env[k];
      process.env[k] = v;
    }
  };
  const goodEnv = () =>
    setEnv({
      ARTIFACT_STORE: "s3",
      S3_ENDPOINT: ENDPOINT as string,
      S3_BUCKET: BUCKET,
      S3_REGION: "us-east-1",
      S3_ACCESS_KEY_ID: ACCESS,
      S3_SECRET_ACCESS_KEY: SECRET,
      S3_PREFIX: "test",
    });
  const container = () => join(mkdtempSync(join(tmpdir(), "rf-s3-")), "evidence");

  beforeAll(async () => {
    store = await import("@/lib/storage/object-store");
    ca = await import("@/lib/storage/content-addressed");
    goodEnv();
    // Create the bucket with the same SigV4 signer the app uses.
    const url = new URL(ENDPOINT as string);
    const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const headers = { host: url.host, "x-amz-date": new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""), "x-amz-content-sha256": hash };
    const authorization = store.signV4({ method: "PUT", path: `/${BUCKET}`, headers, payloadHash: hash, region: "us-east-1", accessKeyId: ACCESS, secretAccessKey: SECRET });
    const { host: _h, ...send } = headers;
    void _h;
    const res = await fetch(`${url.origin}/${BUCKET}`, { method: "PUT", headers: { ...send, authorization } });
    expect([200, 409]).toContain(res.status);
  });
  afterAll(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("worker writes, web reads the same bytes after a cold start", async () => {
    goodEnv();
    const worker = container();
    const bytes = randomBytes(1024);
    const w = await ca.writeImmutable(worker, "videos/h1/walkthrough.mp4", bytes);
    expect(w.alreadyExisted).toBe(false);
    const web = container();
    const path = await ca.ensureLocal(web, "videos/h1/walkthrough.mp4");
    expect(readFileSync(path)).toEqual(bytes);
  });

  it("dedupes the same bytes across containers and refuses different bytes without a local write", async () => {
    goodEnv();
    await ca.writeImmutable(container(), "k/dedupe", Buffer.from("same"));
    expect((await ca.writeImmutable(container(), "k/dedupe", Buffer.from("same"))).alreadyExisted).toBe(true);
    const third = container();
    await expect(ca.writeImmutable(third, "k/dedupe", Buffer.from("different"))).rejects.toThrow(/different bytes/);
    expect(existsSync(join(third, "k/dedupe"))).toBe(false);
    expect((await store.getObject("evidence/k/dedupe"))?.toString()).toBe("same");
  });

  it("two concurrent writers with different bytes: one wins, the other is refused, nothing is overwritten", async () => {
    goodEnv();
    const results = await Promise.allSettled([
      ca.writeImmutable(container(), "race/key", Buffer.from("alpha")),
      ca.writeImmutable(container(), "race/key", Buffer.from("bravo")),
    ]);
    const stored = (await store.getObject("evidence/race/key"))?.toString();
    const winner = results.findIndex((r) => r.status === "fulfilled");
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(stored).toBe(winner === 0 ? "alpha" : "bravo");
  });

  it("reports a missing object honestly", async () => {
    goodEnv();
    expect(await ca.ensureLocalIfStored(container(), "never/written")).toBeNull();
    await expect(ca.ensureLocal(container(), "never/written")).rejects.toThrow(/missing/);
  });

  it("wrong credentials fail closed and leave no local file", async () => {
    goodEnv();
    setEnv({ S3_SECRET_ACCESS_KEY: "wrong-secret" });
    const c = container();
    await expect(ca.writeImmutable(c, "k/badcreds", Buffer.from("x"))).rejects.toThrow(/Object store (HEAD|PUT) failed/);
    expect(existsSync(join(c, "k/badcreds"))).toBe(false);
    goodEnv();
  });

  it("an unreachable store fails closed; the retry after recovery succeeds idempotently", async () => {
    goodEnv();
    setEnv({ S3_ENDPOINT: "http://127.0.0.1:1" });
    const c = container();
    await expect(ca.writeImmutable(c, "k/retry", Buffer.from("payload"))).rejects.toThrow();
    expect(existsSync(join(c, "k/retry"))).toBe(false);
    goodEnv();
    const ok = await ca.writeImmutable(c, "k/retry", Buffer.from("payload"));
    expect(ok.alreadyExisted).toBe(false);
    expect((await ca.writeImmutable(c, "k/retry", Buffer.from("payload"))).alreadyExisted).toBe(true);
  });

  it("round-trips a 5 MB artifact and keys with spaces and unicode", async () => {
    goodEnv();
    const big = randomBytes(5 * 1024 * 1024);
    await ca.writeImmutable(container(), "big/file.bin", big);
    expect(readFileSync(await ca.ensureLocal(container(), "big/file.bin")).equals(big)).toBe(true);
    await ca.writeImmutable(container(), "odd/a b/é (1).txt", Buffer.from("odd"));
    expect(readFileSync(await ca.ensureLocal(container(), "odd/a b/é (1).txt")).toString()).toBe("odd");
  });

  it("an evidence artifact stored by the app is recoverable after its local file is lost", async () => {
    goodEnv();
    const TEST_URL = process.env.TEST_DATABASE_URL;
    if (!TEST_URL) return;
    const { storeArtifact, EVIDENCE_ROOT, artifactPath } = await import("@/lib/evidence/storage");
    const key = `s3-test/${Date.now()}.txt`;
    const stored = await storeArtifact({ kind: "html_snapshot", storageKey: key, mimeType: "text/plain", bytes: Buffer.from("evidence"), captureMethod: "test" });
    expect(stored.sha256).toHaveLength(64);
    rmSync(artifactPath(key));
    expect((await ca.readStored(EVIDENCE_ROOT, key)).toString()).toBe("evidence");
  });
});
