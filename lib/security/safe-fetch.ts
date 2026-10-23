/**
 * Guarded outbound HTTP for anything that fetches an operator- or
 * discovery-supplied URL (docs/10 · audit 2026-08-01 §H.1). One policy,
 * imported everywhere, instead of per-caller fetch calls:
 *
 * - http(s) only; private, reserved and link-local addresses refused — IP
 *   literals are parsed and classified in every notation (spec 158);
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

/** Dotted-quad IPv4 → four octets, or null. */
function parseIPv4(host: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  return octets.every((o) => o <= 255) ? octets : null;
}

/** IPv6 literal (any notation: `::` compression, embedded dotted quad, zone
 * id) → eight 16-bit groups, or null when it is not a valid IPv6 address. */
function parseIPv6(host: string): number[] | null {
  let h = host.split("%")[0]!;
  if (!h.includes(":")) return null;
  const tail = /^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (tail) {
    const v4 = parseIPv4(tail[2]!);
    if (!v4) return null;
    h = `${tail[1]}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
  }
  const halves = h.split("::");
  if (halves.length > 2) return null;
  const parts = (s: string) => (s === "" ? [] : s.split(":"));
  const head = parts(halves[0]!);
  const rest = halves.length === 2 ? parts(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function privateIPv4([a, b, c]: [number, number, number, number]): boolean {
  return (
    a === 0 || // "this network"
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    a === 127 ||
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18/15
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a >= 224 // multicast 224/4, reserved 240/4, broadcast
  );
}

const v4From = (hi: number, lo: number): [number, number, number, number] => [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff];

function privateIPv6(g: number[]): boolean {
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  if (zeros(0, 8)) return true; // ::
  if (zeros(0, 7) && g[7] === 1) return true; // ::1
  // IPv4-mapped (::ffff:a.b.c.d, in ANY notation) and IPv4-compatible (::a.b.c.d)
  if (zeros(0, 5) && g[5] === 0xffff) return privateIPv4(v4From(g[6]!, g[7]!));
  if (zeros(0, 6)) return privateIPv4(v4From(g[6]!, g[7]!));
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return privateIPv4(v4From(g[6]!, g[7]!)); // NAT64
  if (g[0] === 0x2002) return privateIPv4(v4From(g[1]!, g[2]!)); // 6to4
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // unique local fc00::/7
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((g[0]! & 0xffc0) === 0xfec0) return true; // site-local fec0::/10
  if ((g[0]! & 0xff00) === 0xff00) return true; // multicast
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // documentation
  if (g[0] === 0x2001 && g[1] === 0x0000) return true; // Teredo
  return false;
}

/**
 * True when `hostname` (a URL hostname or a resolved address) must not be
 * fetched. IP literals are PARSED and classified (spec 158): the WHATWG URL
 * parser rewrites `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`, which a
 * string check missed. Names are judged only by the reserved suffixes; any
 * other name is decided by its resolved addresses (assertPublicUrl).
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal")) {
    return true;
  }
  const v4 = parseIPv4(host);
  if (v4) return privateIPv4(v4);
  if (host.includes(":")) {
    const v6 = parseIPv6(host);
    // An unparseable "IPv6" literal is refused rather than guessed at.
    return v6 ? privateIPv6(v6) : true;
  }
  return false;
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
