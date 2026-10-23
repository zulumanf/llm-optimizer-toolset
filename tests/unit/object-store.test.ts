/**
 * Release 151 durable artifacts: SigV4 known answer (AWS's published S3
 * "GET Object" example), and the cross-container behaviour of
 * content-addressed storage over an in-memory S3 that checks signatures.
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { encodeKey, setObjectStoreFetchForTests, signV4 } from "@/lib/storage/object-store";
import { ensureLocal, ensureLocalIfStored, readStored, writeImmutable } from "@/lib/storage/content-addressed";

describe("AWS Signature V4 (known answer)", () => {
  it("reproduces the S3 documentation's GET Object signature", () => {
    const auth = signV4({
      method: "GET",
      path: "/test.txt",
      headers: {
        host: "examplebucket.s3.amazonaws.com",
        range: "bytes=0-9",
        "x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "x-amz-date": "20130524T000000Z",
      },
      payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      region: "us-east-1",
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    });
    expect(auth).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    );
  });
  it("encodes keys per S3 rules", () => {
    expect(encodeKey("evidence/a b/c(1).mp4")).toBe("evidence/a%20b/c%281%29.mp4");
  });
});

describe("content-addressed storage over S3 (two containers)", () => {
  const objects = new Map<string, { body: Buffer; sha: string | null }>();
  const forceHeadMissing = new Map<string, number>();
  const saved: Record<string, string | undefined> = {};
  const ENV = {
    ARTIFACT_STORE: "s3",
    S3_ENDPOINT: "http://localhost:9000",
    S3_BUCKET: "rf-artifacts",
    S3_REGION: "auto",
    S3_ACCESS_KEY_ID: "test-key",
    S3_SECRET_ACCESS_KEY: "test-secret",
  };

  beforeEach(() => {
    objects.clear();
    for (const [k, v] of Object.entries(ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
    setObjectStoreFetchForTests(async (url, init) => {
      const headers = new Headers(init?.headers as HeadersInit);
      expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=test-key\//);
      const key = new URL(url).pathname;
      const method = init?.method ?? "GET";
      const obj = objects.get(key);
      if (method === "HEAD") {
        // Simulated race: both writers' HEADs ran before either PUT.
        if (forceHeadMissing.has(key) && forceHeadMissing.get(key)! > 0) {
          forceHeadMissing.set(key, forceHeadMissing.get(key)! - 1);
          return new Response(null, { status: 404 });
        }
        return new Response(null, { status: obj ? 200 : 404, headers: obj?.sha ? { "x-amz-meta-sha256": obj.sha } : {} });
      }
      if (method === "GET") return obj ? new Response(new Uint8Array(obj.body), { status: 200, headers: obj.sha ? { "x-amz-meta-sha256": obj.sha } : {} }) : new Response(null, { status: 404 });
      if (method === "PUT") {
        if (headers.get("if-none-match") === "*" && objects.has(key)) return new Response(null, { status: 412 });
        objects.set(key, { body: Buffer.from(init?.body as Uint8Array), sha: headers.get("x-amz-meta-sha256") });
        return new Response(null, { status: 200 });
      }
      return new Response(null, { status: 405 });
    });
  });
  afterEach(() => {
    setObjectStoreFetchForTests(null);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const container = () => join(mkdtempSync(join(tmpdir(), "rf-art-")), "evidence");

  it("a file written by the worker is readable by the web container, byte for byte", async () => {
    const worker = container();
    const web = container();
    const bytes = Buffer.from("walkthrough.mp4 bytes");
    const w = await writeImmutable(worker, "videos/h1/walkthrough.mp4", bytes);
    expect(w.alreadyExisted).toBe(false);
    expect(objects.has("/rf-artifacts/evidence/videos/h1/walkthrough.mp4")).toBe(true);
    expect(existsSync(join(web, "videos/h1/walkthrough.mp4"))).toBe(false);
    const path = await ensureLocal(web, "videos/h1/walkthrough.mp4");
    expect(readFileSync(path)).toEqual(bytes);
    expect(await readStored(web, "videos/h1/walkthrough.mp4")).toEqual(bytes);
  });

  it("survives a redeploy (empty local cache) and reports absent keys honestly", async () => {
    await writeImmutable(container(), "k1", Buffer.from("a"));
    const fresh = container();
    expect(readFileSync(await ensureLocal(fresh, "k1")).toString()).toBe("a");
    expect(await ensureLocalIfStored(fresh, "never-written")).toBeNull();
    await expect(ensureLocal(fresh, "never-written")).rejects.toThrow(/missing/);
  });

  it("a second container writing the same key sees alreadyExisted; different bytes are a conflict, never an overwrite", async () => {
    await writeImmutable(container(), "k2", Buffer.from("same"));
    const second = await writeImmutable(container(), "k2", Buffer.from("same"));
    expect(second.alreadyExisted).toBe(true);
    const third = container();
    await expect(writeImmutable(third, "k2", Buffer.from("different"))).rejects.toThrow(/different bytes/);
    expect(existsSync(join(third, "k2"))).toBe(false); // refused before any local write
    expect(objects.get("/rf-artifacts/evidence/k2")?.body.toString()).toBe("same");
  });

  it("racing writers: the conditional PUT admits exactly one; the loser with different bytes gets a conflict", async () => {
    forceHeadMissing.set("/rf-artifacts/evidence/race", 2); // both pre-checks miss
    const [a, b] = await Promise.allSettled([
      writeImmutable(container(), "race", Buffer.from("first")),
      writeImmutable(container(), "race", Buffer.from("second")),
    ]);
    const outcomes = [a.status, b.status].sort();
    expect(outcomes).toEqual(["fulfilled", "rejected"]);
    const rejected = [a, b].find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(String(rejected.reason)).toMatch(/different bytes/);
    expect(objects.get("/rf-artifacts/evidence/race")?.body.toString()).toMatch(/^(first|second)$/);
  });

  it("refuses a downloaded object without RF's integrity metadata", async () => {
    objects.set("/rf-artifacts/evidence/foreign", { body: Buffer.from("x"), sha: null });
    await expect(ensureLocal(container(), "foreign")).rejects.toThrow(/integrity/);
  });

  it("a tampered object fails its integrity check on download", async () => {
    await writeImmutable(container(), "k3", Buffer.from("original"));
    objects.get("/rf-artifacts/evidence/k3")!.body = Buffer.from("tampered");
    await expect(ensureLocal(container(), "k3")).rejects.toThrow(/integrity/);
  });

  it("still refuses keys that escape the root", async () => {
    await expect(writeImmutable(container(), "../../etc/x", Buffer.from("x"))).rejects.toThrow(/Invalid storage key/);
  });

  it("refuses a plain-http endpoint that is not localhost", async () => {
    process.env.S3_ENDPOINT = "http://storage.example.com";
    await expect(writeImmutable(container(), "k4", Buffer.from("x"))).rejects.toThrow(/https/);
  });
});
