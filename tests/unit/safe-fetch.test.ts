/**
 * Central outbound-fetch policy (audit 2026-08-01 §H.1). Fetch and DNS are
 * injected — no network. The ambient-DNS default is deliberately off under
 * vitest; these tests exercise the DNS path by injecting a resolver.
 */
import { describe, expect, it } from "vitest";
import {
  assertPublicUrl,
  isPrivateHost,
  safeFetch,
  type LookupImpl,
} from "@/lib/security/safe-fetch";

const publicLookup: LookupImpl = async () => [{ address: "93.184.216.34" }];
const privateLookup: LookupImpl = async () => [{ address: "169.254.169.254" }];

function fetchScript(
  responses: Record<string, () => Response>
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const make = responses[url];
    if (!make) throw new Error(`unexpected fetch: ${url}`);
    return make();
  }) as typeof fetch;
}

describe("isPrivateHost", () => {
  it("judges IPv4-mapped IPv6 as its IPv4 self", () => {
    expect(isPrivateHost("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateHost("::ffff:93.184.216.34")).toBe(false);
  });
});

describe("assertPublicUrl", () => {
  it("refuses non-http schemes and private hosts before any DNS", async () => {
    await expect(assertPublicUrl("file:///etc/passwd", null)).rejects.toThrow(
      /http and https/
    );
    await expect(assertPublicUrl("http://169.254.169.254/x", null)).rejects.toThrow(
      /private or link-local/
    );
  });

  it("refuses a public hostname that resolves to a private address", async () => {
    await expect(
      assertPublicUrl("https://innocent.example/", privateLookup)
    ).rejects.toThrow(/resolves to a private address/);
    await expect(
      assertPublicUrl("https://innocent.example/", publicLookup)
    ).resolves.toBeInstanceOf(URL);
  });
});

describe("safeFetch", () => {
  const OPTS = { timeoutMs: 5_000, maxBytes: 1_000 };

  it("refuses a redirect hop onto a private address", async () => {
    const fetchImpl = fetchScript({
      "https://public.example/doc": () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        }),
    });
    await expect(
      safeFetch("https://public.example/doc", OPTS, { fetchImpl, lookupImpl: null })
    ).rejects.toThrow(/private or link-local/);
  });

  it("re-resolves DNS on every redirect hop", async () => {
    const seen: string[] = [];
    const lookupImpl: LookupImpl = async (host) => {
      seen.push(host);
      return host === "evil.example"
        ? [{ address: "10.0.0.1" }]
        : [{ address: "93.184.216.34" }];
    };
    const fetchImpl = fetchScript({
      "https://public.example/doc": () =>
        new Response(null, {
          status: 301,
          headers: { location: "https://evil.example/steal" },
        }),
    });
    await expect(
      safeFetch("https://public.example/doc", OPTS, { fetchImpl, lookupImpl })
    ).rejects.toThrow(/resolves to a private address/);
    expect(seen).toEqual(["public.example", "evil.example"]);
  });

  it("follows a public redirect chain and reports the final URL", async () => {
    const fetchImpl = fetchScript({
      "https://a.example/": () =>
        new Response(null, { status: 308, headers: { location: "/moved" } }),
      "https://a.example/moved": () =>
        new Response("hello", { status: 200 }),
    });
    const result = await safeFetch("https://a.example/", OPTS, {
      fetchImpl,
      lookupImpl: publicLookup,
    });
    expect(result.ok).toBe(true);
    expect(result.bytes.toString("utf8")).toBe("hello");
    expect(result.finalUrl).toBe("https://a.example/moved");
  });

  it("stops an unbounded redirect chain", async () => {
    const fetchImpl = fetchScript({
      "https://loop.example/": () =>
        new Response(null, { status: 302, headers: { location: "/" } }),
    });
    await expect(
      safeFetch("https://loop.example/", OPTS, { fetchImpl, lookupImpl: null })
    ).rejects.toThrow(/Too many redirects/);
  });

  it("caps the response size, by declared length and by actual bytes", async () => {
    const big = "x".repeat(2_000);
    const declared = fetchScript({
      "https://big.example/": () =>
        new Response(big, { status: 200, headers: { "content-length": "2000" } }),
    });
    await expect(
      safeFetch("https://big.example/", OPTS, { fetchImpl: declared, lookupImpl: null })
    ).rejects.toThrow(/byte/);

    // No content-length header: the stream itself must be capped.
    const sneaky = fetchScript({
      "https://big.example/": () => {
        const res = new Response(big, { status: 200 });
        res.headers.delete("content-length");
        return res;
      },
    });
    await expect(
      safeFetch("https://big.example/", OPTS, { fetchImpl: sneaky, lookupImpl: null })
    ).rejects.toThrow(/byte/);
  });
});
