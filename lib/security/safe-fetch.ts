/**
 * Guarded outbound HTTP for anything that fetches an operator- or
 * discovery-supplied URL (docs/10 · audit 2026-08-01 §H.1). One policy,
 * imported everywhere, instead of per-caller fetch calls:
 *
 * - http(s) only; private/link-local hosts refused (string check);
 * - the hostname is DNS-resolved and every address must be public — a public
 *   name pointing at 169.254.169.254 is refused (best-effort: the classic
 *   resolve-then-connect race is documented, not solved);
 * - redirects are followed MANUALLY, re-validating every hop — a public host
 *   302-ing to a private address is refused, which `redirect: "follow"`
 *   silently permitted;
 * - responses are size-capped while streaming, not after download.
 *
 * Under vitest the ambient DNS check is skipped: integration suites stub the
 * global fetch with fictional hostnames that must not hit a real resolver.
 * The DNS path is covered by unit tests that inject `lookupImpl`.
 */
import { lookup } from "node:dns/promises";
import { ClassifiedError } from "@/lib/errors";

export const MAX_REDIRECTS_DEFAULT = 5;

export function isPrivateHost(hostname: string): boolean {
  let host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) must be judged as its IPv4 self.
  if (host.startsWith("::ffff:")) host = host.slice("::ffff:".length);
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return true;
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!ipv4) return false;
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export type LookupImpl = (
  hostname: string
) => Promise<{ address: string }[]>;

const defaultLookup: LookupImpl = async (hostname) =>
  lookup(hostname, { all: true, verbatim: true });

function isIpLiteral(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "");
  return /^[\d.]+$/.test(host) || host.includes(":");
}

/** Scheme + private-host + DNS policy for one URL. Throws ClassifiedError. */
export async function assertPublicUrl(
  rawUrl: string,
  lookupImpl?: LookupImpl | null
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new ClassifiedError("validation", `Not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ClassifiedError("validation", "Only http and https sources can be fetched.");
  }
  if (isPrivateHost(parsed.hostname)) {
    throw new ClassifiedError(
      "forbidden",
      "That host is on a private or link-local network and will not be fetched."
    );
  }
  const resolver =
    lookupImpl !== undefined ? lookupImpl : process.env.VITEST ? null : defaultLookup;
  if (resolver && !isIpLiteral(parsed.hostname)) {
    let addresses: { address: string }[];
    try {
      addresses = await resolver(parsed.hostname);
    } catch {
      throw new ClassifiedError("internal", `Could not resolve ${parsed.hostname}.`);
    }
    for (const { address } of addresses) {
      if (isPrivateHost(address)) {
        throw new ClassifiedError(
          "forbidden",
          `${parsed.hostname} resolves to a private address and will not be fetched.`
        );
      }
    }
  }
  return parsed;
}

export interface SafeFetchOptions {
  timeoutMs: number;
  /** Hard cap on response bytes, enforced while reading the stream. */
  maxBytes: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
}

export interface SafeFetchDeps {
  fetchImpl?: typeof fetch;
  /** Pass null to disable DNS validation, a function to inject one. */
  lookupImpl?: LookupImpl | null;
}

export interface SafeFetchResult {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  bytes: Buffer;
  /** Where the response actually came from after redirects. */
  finalUrl: string;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function safeFetch(
  rawUrl: string,
  opts: SafeFetchOptions,
  deps: SafeFetchDeps = {}
): Promise<SafeFetchResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS_DEFAULT;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    let url = rawUrl;
    for (let hop = 0; ; hop += 1) {
      const parsed = await assertPublicUrl(url, deps.lookupImpl);
      const response = await fetchImpl(parsed.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: opts.headers,
      });
      if (REDIRECT_STATUSES.has(response.status)) {
        // Drain nothing — a redirect body is irrelevant; validate the target.
        const location = response.headers.get("location");
        if (!location) {
          throw new ClassifiedError(
            "internal",
            `Redirect from ${url} carried no Location header.`
          );
        }
        if (hop >= maxRedirects) {
          throw new ClassifiedError(
            "internal",
            `Too many redirects fetching ${rawUrl} (limit ${maxRedirects}).`
          );
        }
        url = new URL(location, parsed).toString();
        continue;
      }
      const bytes = await readCapped(response, opts.maxBytes, url);
      return {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        headers: response.headers,
        bytes,
        finalUrl: url,
      };
    }
  } catch (err) {
    if (err instanceof ClassifiedError) throw err;
    if ((err as Error).name === "AbortError") {
      throw new ClassifiedError(
        "timeout",
        `Fetching ${rawUrl} exceeded ${opts.timeoutMs}ms.`
      );
    }
    throw new ClassifiedError(
      "internal",
      `Could not fetch ${rawUrl}: ${(err as Error).message}`
    );
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(
  response: Response,
  maxBytes: number,
  url: string
): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ClassifiedError(
      "validation",
      `${url} declares ${declared} bytes, over the ${maxBytes}-byte limit.`
    );
  }
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) {
      throw new ClassifiedError(
        "validation",
        `${url} exceeded the ${maxBytes}-byte response limit.`
      );
    }
    return buffer;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new ClassifiedError(
        "validation",
        `${url} exceeded the ${maxBytes}-byte response limit.`
      );
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
