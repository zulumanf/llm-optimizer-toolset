/**
 * S3-compatible object storage for artifacts (release 151). The durable
 * source of truth when `ARTIFACT_STORE=s3`; the local artifact directory
 * becomes a per-container cache. Works with any S3-compatible endpoint
 * (AWS S3, Cloudflare R2, Backblaze B2, MinIO, Railway buckets) through
 * path-style requests signed with AWS Signature V4 — implemented here on
 * node:crypto and fetch, so no SDK dependency.
 *
 * Objects are content-addressed and write-once: a PUT is preceded by a HEAD;
 * an existing object with a different sha256 is a conflict, never an
 * overwrite. Credentials come only from the environment and are never logged.
 */
import { createHash, createHmac } from "node:crypto";
import { ClassifiedError } from "@/lib/errors";

export interface ObjectStoreConfig {
  endpoint: string;
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  prefix: string;
}

export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchFn = (input, init) => fetch(input, init);
/** Tests inject an in-memory store; production uses global fetch. */
export function setObjectStoreFetchForTests(f: FetchFn | null): void {
  fetchImpl = f ?? ((input, init) => fetch(input, init));
}

export function objectStoreEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (env.ARTIFACT_STORE ?? "local").trim().toLowerCase() === "s3";
}

export function objectStoreConfig(env: Record<string, string | undefined> = process.env): ObjectStoreConfig {
  const need = (k: string) => {
    const v = env[k]?.trim();
    if (!v) throw new ClassifiedError("internal", `ARTIFACT_STORE=s3 requires ${k}.`);
    return v;
  };
  const endpoint = need("S3_ENDPOINT").replace(/\/+$/, "");
  if (!/^https:\/\//.test(endpoint) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(endpoint)) {
    throw new ClassifiedError("internal", "S3_ENDPOINT must be https (plain http only for localhost).");
  }
  return {
    endpoint,
    bucket: need("S3_BUCKET"),
    region: env.S3_REGION?.trim() || "auto",
    accessKeyId: need("S3_ACCESS_KEY_ID"),
    secretAccessKey: need("S3_SECRET_ACCESS_KEY"),
    prefix: (env.S3_PREFIX?.trim() ?? "").replace(/^\/+|\/+$/g, ""),
  };
}

const sha256Hex = (data: string | Buffer | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding per S3 rules (each path segment; '/' preserved). */
export function encodeKey(key: string): string {
  return key
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/**
 * AWS Signature V4 for a single request. Pure (tested against the published
 * S3 GET Object example). `headers` must include host, x-amz-date and
 * x-amz-content-sha256; all supplied headers are signed.
 */
export function signV4(input: {
  method: string;
  path: string; // already URI-encoded
  query?: string;
  headers: Record<string, string>;
  payloadHash: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  service?: string;
}): string {
  const service = input.service ?? "s3";
  const amzDate = input.headers["x-amz-date"] as string;
  const date = amzDate.slice(0, 8);
  const names = Object.keys(input.headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const canonicalHeaders = names.map((n) => `${n}:${String(lower[n]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = names.join(";");
  const canonicalRequest = [input.method, input.path, input.query ?? "", canonicalHeaders, signedHeaders, input.payloadHash].join("\n");
  const scope = `${date}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256Hex(canonicalRequest)].join("\n");
  const kDate = hmac(`AWS4${input.secretAccessKey}`, date);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function amzNow(now = new Date()): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

async function request(
  cfg: ObjectStoreConfig,
  method: "GET" | "PUT" | "HEAD",
  objectKey: string,
  body?: Buffer,
  extraHeaders: Record<string, string> = {}
): Promise<Response> {
  const url = new URL(cfg.endpoint);
  const fullKey = cfg.prefix ? `${cfg.prefix}/${objectKey}` : objectKey;
  const path = `${url.pathname.replace(/\/+$/, "")}/${encodeKey(cfg.bucket)}/${encodeKey(fullKey)}`;
  const payloadHash = sha256Hex(body ?? "");
  const headers: Record<string, string> = {
    host: url.host,
    "x-amz-date": amzNow(),
    "x-amz-content-sha256": payloadHash,
    ...extraHeaders,
  };
  const authorization = signV4({ method, path, headers, payloadHash, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
  const { host: _host, ...sendHeaders } = headers;
  void _host;
  return fetchImpl(`${url.origin}${path}`, {
    method,
    headers: { ...sendHeaders, authorization },
    body: body ? new Uint8Array(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
}

const accessHint = (status: number) =>
  status === 403
    ? " — the credential is refused: it needs s3:GetObject, s3:PutObject and s3:ListBucket on the bucket (without ListBucket, S3 answers 403 instead of 404 for a missing object)"
    : "";

async function confirmExisting(cfg: ObjectStoreConfig, objectKey: string, sha256: string): Promise<"already_present"> {
  const head = await request(cfg, "HEAD", objectKey);
  if (head.status !== 200) throw new ClassifiedError("internal", `Object store HEAD failed (${head.status})${accessHint(head.status)}.`);
  const existing = head.headers.get("x-amz-meta-sha256");
  if (existing !== sha256) {
    throw new ClassifiedError("conflict", `Object "${objectKey}" already holds different bytes.`);
  }
  return "already_present";
}

/**
 * Write-once upload. Returns "uploaded" | "already_present".
 * The HEAD is an optimisation; the guarantee is the conditional PUT
 * (`If-None-Match: *`): when two writers race, the store accepts exactly
 * one and answers 412 to the other, which then compares sha256. A store
 * that ignores the condition still never silently accepts different bytes
 * from this code path, because the pre-check refused them.
 */
export async function putObjectOnce(objectKey: string, bytes: Buffer, sha256: string, cfg = objectStoreConfig()): Promise<"uploaded" | "already_present"> {
  const head = await request(cfg, "HEAD", objectKey);
  if (head.status === 200) return confirmExisting(cfg, objectKey, sha256);
  if (head.status !== 404) throw new ClassifiedError("internal", `Object store HEAD failed (${head.status})${accessHint(head.status)}.`);
  const put = await request(cfg, "PUT", objectKey, bytes, {
    "x-amz-meta-sha256": sha256,
    "content-type": "application/octet-stream",
    "if-none-match": "*",
  });
  if (put.status === 412 || put.status === 409) return confirmExisting(cfg, objectKey, sha256);
  if (!put.ok) throw new ClassifiedError("internal", `Object store PUT failed (${put.status})${accessHint(put.status)}.`);
  return "uploaded";
}

/** Download an object; null when absent. Verifies the stored sha256. */
export async function getObject(objectKey: string, cfg = objectStoreConfig()): Promise<Buffer | null> {
  const res = await request(cfg, "GET", objectKey);
  if (res.status === 404) return null;
  if (!res.ok) throw new ClassifiedError("internal", `Object store GET failed (${res.status})${accessHint(res.status)}.`);
  const bytes = Buffer.from(await res.arrayBuffer());
  // Every object this code writes carries its sha256; one without it was not
  // written by RF (or was altered out of band) and is refused, not trusted.
  const expected = res.headers.get("x-amz-meta-sha256");
  if (!expected || sha256Hex(bytes) !== expected) {
    throw new ClassifiedError("internal", `Object "${objectKey}" failed its integrity check.`);
  }
  return bytes;
}

/** Read-only probe for preflight: can this credential tell "missing" from
 * "forbidden"? Returns the HEAD status for a key that never exists. */
export async function probeMissingObjectStatus(cfg = objectStoreConfig()): Promise<number> {
  const res = await request(cfg, "HEAD", `__rf_preflight_probe__/${Date.now()}`);
  return res.status;
}
