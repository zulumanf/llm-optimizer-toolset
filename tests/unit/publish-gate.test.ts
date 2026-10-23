import { describe, expect, it } from "vitest";
import { decidePublishable } from "@/lib/content/publish-gate";

const passed = { gate: { ok: true }, passed: true };
const asset = { id: "a1", projectId: "p1", status: "approved" };
const body = "Rivera Team serves Springfield [claim:11111111-1111-4111-8111-111111111111].";
const base = { capability: "cms.create_draft", projectId: "p1", asset, latestVersion: { body, verification: passed } };

describe("content publishing gate (release 151)", () => {
  it("allows only the approved, verified text of the referenced asset", () => {
    expect(decidePublishable({ ...base, payload: { contentAssetId: "a1", content: "Rivera Team serves Springfield." } })).toEqual({ ok: true, assetId: "a1" });
  });
  it.each([
    [{ content: "x" }, asset, passed, "content_asset_required"],
    [{ contentAssetId: "a1", content: "x" }, null, passed, "content_asset_missing"],
    [{ contentAssetId: "a1", content: "x" }, { ...asset, projectId: "p2" }, passed, "content_asset_tenant"],
    [{ contentAssetId: "a1", content: "x" }, { ...asset, status: "verified" }, passed, "content_not_approved"],
    [{ contentAssetId: "a1", content: "Rivera Team serves Springfield." }, asset, { gate: { ok: false }, passed: false }, "content_failed_validation"],
    [{ contentAssetId: "a1", content: "Rivera Team is the #1 agent in Springfield." }, asset, passed, "content_mismatch"],
  ])("refuses %#", (payload, a, verification, code) => {
    const r = decidePublishable({ ...base, payload, asset: a, latestVersion: { body, verification } });
    expect(r).toMatchObject({ ok: false, code });
  });
  it("publish needs an approved asset but no body comparison", () => {
    expect(decidePublishable({ ...base, capability: "cms.publish_approved_asset", payload: { contentAssetId: "a1", externalId: "9" } }).ok).toBe(true);
  });
});
