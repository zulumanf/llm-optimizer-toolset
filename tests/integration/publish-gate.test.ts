/** Release 151: no CMS capability runs without an approved, verified content asset. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("content publishing gate at the connector boundary (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let execute: typeof import("@/lib/connectors/execute");
  let projectId: string;

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    execute = await import("@/lib/connectors/execute");
  });
  afterAll(async () => {
    await sql.end();
  });
  beforeEach(async () => {
    await truncateAll(sql);
    const [p] = await sql`insert into projects (name) values ('Gate') returning id`;
    projectId = p!.id as string;
  });

  it("refuses a workflow draft that never went through the content pipeline (the automation v2 path)", async () => {
    for (const mode of ["live", "test"] as const) {
      const r = await execute.executeCapability({
        capability: "cms.create_draft",
        projectId,
        mode,
        input: { title: "Agent-drafted", content: "Rivera Team is the best agent in Springfield." },
      });
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe("content_asset_required");
    }
    const exceptions = await sql`select kind from workflow_exceptions where project_id = ${projectId}`;
    expect(exceptions.map((e) => e.kind)).toContain("evidence_conflict");
  });

  it("lets an approved, verified asset through to the normal connector path", async () => {
    const [asset] = await sql`
      insert into content_assets (project_id, asset_type, title, status) values (${projectId}, 'service_page', 'Page', 'approved') returning id
    `;
    await sql`
      insert into content_versions (asset_id, version, body, author, verification)
      values (${asset!.id}, 1, 'Rivera Team serves Springfield.', 'agent:test', ${sql.json({ gate: { ok: true }, passed: true })})
    `;
    const r = await execute.executeCapability({
      capability: "cms.create_draft",
      projectId,
      mode: "live",
      input: { contentAssetId: asset!.id, title: "Page", content: "Rivera Team serves Springfield." },
    });
    // Past the gate: it now fails only because no CMS is connected.
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe("no_connection");
  });

  it("the automation publish path builds its CMS payload only from the approved asset (consolidation)", async () => {
    const { domainNodes } = await import("@/lib/automation/nodes/domain");
    const node = domainNodes["dom.canonical_publish_input"]!;
    const [asset] = await sql`
      insert into content_assets (project_id, asset_type, title, status) values (${projectId}, 'guide', 'Guide', 'approved') returning id
    `;
    await sql`
      insert into content_versions (asset_id, version, body, author, verification)
      values (${asset!.id}, 1, 'Rivera Team serves Springfield [claim:11111111-1111-4111-8111-111111111111].', 'agent:test',
        ${sql.json({ gate: { ok: true }, passed: true })})
    `;
    const ctx = (assetId: string | null) =>
      ({
        projectId,
        runId: "00000000-0000-4000-8000-000000000999",
        nodeKey: "canonical_content",
        fanKey: "",
        inputs: {},
        workflowInput: { payload: assetId ? { contentAssetId: assetId } : {} },
        config: { mode: "draft", assetIdPath: "payload.contentAssetId" },
      }) as unknown as Parameters<typeof node>[0];
    const ok = await node(ctx(asset!.id as string));
    expect(ok).toMatchObject({ outcome: "succeeded", output: { contentAssetId: asset!.id, title: "Guide", content: "Rivera Team serves Springfield." } });
    expect((await node(ctx(null))).outcome).toBe("safe_stop");
    await sql`insert into content_versions (asset_id, version, body, author, verification) values (${asset!.id}, 2, 'Unverified rewrite.', 'user:x', ${sql.json({ passed: false })})`;
    expect(await node(ctx(asset!.id as string))).toMatchObject({ outcome: "safe_stop" });
  });

  it("publication is bound to the approved run's own draft: a bare or foreign approval is refused", async () => {
    const [asset] = await sql`
      insert into content_assets (project_id, asset_type, title, status) values (${projectId}, 'guide', 'G', 'approved') returning id
    `;
    await sql`
      insert into content_versions (asset_id, version, body, author, verification)
      values (${asset!.id}, 1, 'Text.', 'agent:test', ${sql.json({ gate: { ok: true }, passed: true })})
    `;
    const noApproval = await execute.executeCapability({
      capability: "cms.publish_approved_asset", projectId, mode: "live",
      input: { contentAssetId: asset!.id, externalId: "42" },
    });
    expect(noApproval.errorCode).toBe("publication_unbound");
    const unknown = await execute.executeCapability({
      capability: "cms.publish_approved_asset", projectId, mode: "live",
      input: { contentAssetId: asset!.id, externalId: "42", approvalId: "00000000-0000-4000-8000-0000000000ab" },
    });
    expect(unknown.errorCode).toBe("publication_not_approved");
  });
});

