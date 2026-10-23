/**
 * Spec 158 H3: isPrivateHost classifies parsed addresses. The regression this
 * pins: WHATWG URL rewrites `[::ffff:169.254.169.254]` to `[::ffff:a9fe:a9fe]`,
 * which the old string check let through to the cloud metadata endpoint.
 */
import { describe, expect, it } from "vitest";
import { assertPublicUrl, isPrivateHost } from "@/lib/security/safe-fetch";

const viaUrl = (u: string) => isPrivateHost(new URL(u).hostname);

describe("isPrivateHost — refused", () => {
  it.each([
    ["0.0.0.0"], ["10.1.2.3"], ["100.64.0.1"], ["100.127.255.254"], ["127.0.0.1"], ["127.8.8.8"],
    ["169.254.169.254"], ["172.16.0.1"], ["172.31.255.255"], ["192.0.0.8"], ["192.0.2.1"],
    ["192.168.1.1"], ["198.18.0.1"], ["198.19.255.1"], ["198.51.100.7"], ["203.0.113.9"],
    ["224.0.0.1"], ["239.255.255.250"], ["240.0.0.1"], ["255.255.255.255"],
  ])("IPv4 %s", (ip) => expect(isPrivateHost(ip)).toBe(true));

  it.each([
    ["::"], ["::1"], ["[::1]"], ["::ffff:127.0.0.1"], ["::ffff:7f00:1"], ["::ffff:a9fe:a9fe"],
    ["0:0:0:0:0:ffff:a9fe:a9fe"], ["::ffff:10.0.0.1"], ["::127.0.0.1"], ["::a9fe:a9fe"],
    ["64:ff9b::a9fe:a9fe"], ["64:ff9b::10.0.0.1"], ["2002:a9fe:a9fe::1"], ["2002:7f00:1::"],
    ["fc00::1"], ["fd12:3456::1"], ["fe80::1"], ["fe80::1%eth0"], ["febf::1"], ["fec0::1"],
    ["ff02::1"], ["2001:db8::1"], ["2001:0:4136:e378::1"],
  ])("IPv6 %s", (ip) => expect(isPrivateHost(ip)).toBe(true));

  it.each([
    ["http://[::ffff:169.254.169.254]/latest/meta-data"],
    ["http://[::ffff:127.0.0.1]:8080/"],
    ["http://[0:0:0:0:0:ffff:0a00:0001]/"],
    ["http://2130706433/"], // decimal 127.0.0.1 — URL normalises it
    ["http://0x7f.1/"],
    ["http://localhost./"],
    ["http://api.internal/"],
    ["http://foo.localhost/"],
  ])("after URL normalisation: %s", (u) => expect(viaUrl(u)).toBe(true));

  it("refuses an unparseable IPv6-looking literal rather than guessing", () => {
    expect(isPrivateHost("::ffff:zz")).toBe(true);
  });
});

describe("isPrivateHost — allowed", () => {
  it.each([
    ["8.8.8.8"], ["1.1.1.1"], ["100.63.255.255"], ["100.128.0.1"], ["172.15.0.1"], ["172.32.0.1"],
    ["192.0.1.1"], ["198.17.0.1"], ["198.20.0.1"], ["223.255.255.255"],
    ["2606:4700:4700::1111"], ["2001:4860:4860::8888"], ["::ffff:8.8.8.8"], ["2002:0808:0808::1"],
  ])("public address %s", (ip) => expect(isPrivateHost(ip)).toBe(false));

  it.each([["example.com"], ["fd.example.com"], ["fc-realty.com"], ["fe80.example.org"], ["www.zillow.com"]])(
    "public name %s (no longer judged by text prefix)",
    (h) => expect(isPrivateHost(h)).toBe(false)
  );
});

describe("assertPublicUrl uses the same classifier for resolved addresses", () => {
  it("refuses a public name that resolves to a mapped private address", async () => {
    await expect(assertPublicUrl("https://evil.example/", async () => [{ address: "::ffff:a9fe:a9fe" }])).rejects.toMatchObject({ kind: "forbidden" });
    await expect(assertPublicUrl("https://evil.example/", async () => [{ address: "100.64.1.1" }])).rejects.toMatchObject({ kind: "forbidden" });
  });
  it("allows a public name that resolves to public addresses only", async () => {
    await expect(assertPublicUrl("https://ok.example/", async () => [{ address: "93.184.216.34" }, { address: "2606:2800:220:1::1" }])).resolves.toBeInstanceOf(URL);
  });
});
