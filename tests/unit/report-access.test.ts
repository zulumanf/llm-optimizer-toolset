/**
 * Spec 134: the pure edges of private report access — slug rules, scanner
 * detection, session-token hashing, cookie naming, invitation URL shape,
 * HTML link labeling, and the log redaction that keeps credentials out of
 * every structured line.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  hashSessionToken,
  invitationLinkLabels,
  isReportSlug,
  isScannerUserAgent,
  newSessionToken,
  parseReportNext,
  sessionAllowanceDefault,
  sessionCookieName,
  DEFAULT_SESSION_ALLOWANCE,
} from "@/lib/prospects/report-access";
import { disambiguateSlug } from "@/lib/prospects/links";
import { reportInvitationUrl, reportUrl } from "@/lib/prospects/urls";
import { redactCredentialPaths } from "@/lib/logger";
import { plainTextToTrackedHtml } from "@/lib/text/html";

const KEY = "2f0AiHdXusnDhMop";
const LEGACY = "a".repeat(43);

describe("report slugs", () => {
  it("accepts lowercase URL-safe slugs and rejects everything else", () => {
    expect(isReportSlug("blu-house")).toBe(true);
    expect(isReportSlug("blu-house-grand-rapids")).toBe(true);
    expect(isReportSlug("Blu-House")).toBe(false);
    expect(isReportSlug("-blu")).toBe(false);
    expect(isReportSlug("blu/../x")).toBe(false);
    expect(isReportSlug("")).toBe(false);
  });

  it("disambiguates with the market first, then the smallest number", () => {
    expect(disambiguateSlug("blu-house", "grand-rapids", new Set())).toBe("blu-house");
    expect(disambiguateSlug("blu-house", "grand-rapids", new Set(["blu-house"]))).toBe("blu-house-grand-rapids");
    expect(disambiguateSlug("blu-house", "grand-rapids", new Set(["blu-house", "blu-house-grand-rapids"]))).toBe("blu-house-2");
    expect(disambiguateSlug("blu-house", null, new Set(["blu-house", "blu-house-2"]))).toBe("blu-house-3");
  });

  it("only allows the two known sub-pages as an exchange landing", () => {
    expect(parseReportNext("answers")).toBe("answers");
    expect(parseReportNext("walkthrough")).toBe("walkthrough");
    expect(parseReportNext("//evil.example")).toBeNull();
    expect(parseReportNext(null)).toBeNull();
  });
});

describe("scanner detection", () => {
  it("treats empty, bare and script agents as scanners; real browsers as humans", () => {
    expect(isScannerUserAgent(null)).toBe(true);
    expect(isScannerUserAgent("Mozilla/5.0")).toBe(true);
    expect(isScannerUserAgent("curl/8.4")).toBe(true);
    expect(isScannerUserAgent("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe(true);
    expect(isScannerUserAgent("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/128.0 Safari/537.36")).toBe(false);
    expect(isScannerUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Mobile/15E148 Safari/604.1")).toBe(false);
  });
});

describe("session tokens and cookies", () => {
  it("mints 256-bit base64url tokens and stores only a SHA-256 hash", () => {
    const t = newSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionToken()).not.toBe(t);
    expect(hashSessionToken(t)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashSessionToken(t)).not.toContain(t);
  });

  it("names the cookie per report slug", () => {
    expect(sessionCookieName("blu-house")).toBe("rfr_blu-house");
  });

  it("reads the allowance from the environment with a safe default", () => {
    const prev = process.env.REPORT_SESSION_ALLOWANCE;
    delete process.env.REPORT_SESSION_ALLOWANCE;
    expect(sessionAllowanceDefault()).toBe(DEFAULT_SESSION_ALLOWANCE);
    process.env.REPORT_SESSION_ALLOWANCE = "8";
    expect(sessionAllowanceDefault()).toBe(8);
    process.env.REPORT_SESSION_ALLOWANCE = "zero";
    expect(sessionAllowanceDefault()).toBe(DEFAULT_SESSION_ALLOWANCE);
    if (prev === undefined) delete process.env.REPORT_SESSION_ALLOWANCE;
    else process.env.REPORT_SESSION_ALLOWANCE = prev;
  });
});

describe("invitation URLs and HTML labels", () => {
  const prev = process.env.APP_URL;
  beforeEach(() => {
    process.env.APP_URL = "https://app.recommendedfirst.com/";
  });
  afterEach(() => {
    if (prev === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = prev;
  });

  it("builds the invitation and the clean URL from APP_URL", () => {
    expect(reportInvitationUrl("blu-house", KEY)).toBe(`https://app.recommendedfirst.com/report/blu-house/${KEY}`);
    expect(reportUrl("blu-house")).toBe("https://app.recommendedfirst.com/report/blu-house");
    delete process.env.APP_URL;
    expect(reportInvitationUrl("blu-house", KEY)).toBeNull();
  });

  it("labels only invitation URLs, once each, and leaves legacy and other links alone", () => {
    const inv = `https://app.recommendedfirst.com/report/blu-house/${KEY}`;
    const body = `Here it is: ${inv}\n\nAgain: ${inv}\nOld: https://app.recommendedfirst.com/audit/blu-house/${KEY}\nSite: https://recommendedfirst.com`;
    expect(invitationLinkLabels(body, "Blu House Properties")).toEqual([
      { url: inv, label: "Private report for Blu House Properties" },
    ]);
    expect(invitationLinkLabels("no links here", "X")).toEqual([]);
  });

  it("renders a labeled anchor in the HTML part while the text stays plain", () => {
    const inv = `https://app.recommendedfirst.com/report/blu-house/${KEY}`;
    const html = plainTextToTrackedHtml(`Ryan,\n\nHere it is: ${inv}\n\nFrancisco`, null, [
      { url: inv, label: "Private report for Blu House Properties" },
    ]);
    expect(html).toContain(`<a href="${inv}">Private report for Blu House Properties</a>`);
    expect(html.split(inv).length - 1).toBe(1);
    expect(html).toContain("Ryan,<br>");
    // Unchanged behaviour with no labels: the URL is plain escaped text.
    const plain = plainTextToTrackedHtml(`Here it is: ${inv}`, null);
    expect(plain).not.toContain("<a ");
    expect(plain).toContain(inv);
  });
});

describe("log redaction", () => {
  it("redacts invitation keys and legacy tokens wherever they appear", () => {
    const line = JSON.stringify({
      path: `/report/blu-house/${KEY}`,
      legacy: `/audit/blu-house-properties/${KEY}`,
      bare: `/audit/${LEGACY}`,
      url: `https://app.recommendedfirst.com/report/blu-house/${KEY}?next=answers`,
      clean: "/report/blu-house",
      answers: "/report/blu-house/answers",
    });
    const out = redactCredentialPaths(line);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(LEGACY);
    expect(out).toContain("/report/blu-house/[redacted]");
    expect(out).toContain("/audit/blu-house-properties/[redacted]");
    expect(out).toContain("/audit/[redacted]");
    expect(out).toContain('"clean":"/report/blu-house"');
    expect(out).toContain('"answers":"/report/blu-house/answers"');
  });
});
