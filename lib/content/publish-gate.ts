/**
 * The one gate in front of every route that can put client content on a
 * public page (release 151 review). `lib/content/service.ts` is the only
 * pipeline that drafts from approved claims, runs the deterministic
 * citation validator and the independent fact verifier, and requires a
 * human approval (`content_assets.status = 'approved'`). Any CMS write —
 * from the content UI, the spec-018 template or an automation workflow —
 * must therefore name that approved asset, and the text it sends must be
 * exactly the asset's publishable rendering. A workflow that drafted text
 * some other way cannot publish it.
 */
import { createHash } from "node:crypto";
import { sql } from "@/db/client";
import { renderPublishable } from "@/lib/content/validate";

export const CONTENT_PUBLISHING_CAPABILITIES = new Set([
  "cms.create_draft",
  "cms.update_draft",
  "cms.publish_approved_asset",
]);

export type PublishGateResult = { ok: true; assetId: string } | { ok: false; code: string; reason: string };

const normalize = (text: string) => text.replace(/\r\n/g, "\n").trim();
export const contentHash = (text: string) => createHash("sha256").update(normalize(text)).digest("hex");

/** Pure decision over the loaded asset (tested directly). */
export function decidePublishable(input: {
  capability: string;
  projectId: string | null;
  payload: Record<string, unknown>;
  asset: { id: string; projectId: string; status: string } | null;
  latestVersion: { body: string; verification: unknown } | null;
}): PublishGateResult {
  const { payload, asset, latestVersion } = input;
  if (typeof payload.contentAssetId !== "string" || payload.contentAssetId.length === 0) {
    return { ok: false, code: "content_asset_required", reason: "CMS writes must reference an approved content asset produced by the evidence-checked content pipeline." };
  }
  if (!asset) return { ok: false, code: "content_asset_missing", reason: "The referenced content asset does not exist." };
  if (asset.projectId !== input.projectId) {
    return { ok: false, code: "content_asset_tenant", reason: "The content asset belongs to another client." };
  }
  if (asset.status !== "approved" && asset.status !== "published") {
    return { ok: false, code: "content_not_approved", reason: `The content asset is ${asset.status}; only a human-approved asset can be published.` };
  }
  if (!latestVersion) return { ok: false, code: "content_version_missing", reason: "The approved asset has no stored version." };
  // lib/content/service.verifyDraft stores { gate, factVerification,
  // adversarial, passed } on the version it verified.
  const verification = (latestVersion.verification ?? {}) as { gate?: { ok?: boolean }; passed?: boolean };
  if (verification.passed !== true || verification.gate?.ok !== true) {
    return {
      ok: false,
      code: "content_failed_validation",
      reason: "The latest version did not pass the citation validator and fact verification.",
    };
  }
  if (input.capability !== "cms.publish_approved_asset") {
    if (typeof payload.content !== "string") {
      return { ok: false, code: "content_missing", reason: "No content to send." };
    }
    if (contentHash(payload.content) !== contentHash(renderPublishable(latestVersion.body))) {
      return { ok: false, code: "content_mismatch", reason: "The text sent differs from the approved, validated version." };
    }
  }
  return { ok: true, assetId: asset.id };
}

/**
 * Publication binding (release 151 review): `cms.publish_approved_asset` may
 * only publish the CMS draft that THIS gate admitted for THIS asset, released
 * by a recorded approval in the same project. Evidence: an approved
 * workflow_approvals row (same project) whose workflow run has a succeeded
 * `cms_draft` node that created `externalId` from the same contentAssetId.
 */
export async function publicationBinding(input: {
  projectId: string | null;
  payload: Record<string, unknown>;
}): Promise<PublishGateResult | null> {
  const approvalId = typeof input.payload.approvalId === "string" ? input.payload.approvalId : "";
  const externalId = input.payload.externalId === undefined ? "" : String(input.payload.externalId);
  const assetId = String(input.payload.contentAssetId ?? "");
  const uuid = /^[0-9a-f-]{36}$/i;
  if (!uuid.test(approvalId) || externalId.length === 0) {
    return { ok: false, code: "publication_unbound", reason: "Publication needs the approval that released it and the CMS draft id it publishes." };
  }
  const [approval] = await sql`
    select a.workflow_run_id, a.project_id, a.decision from workflow_approvals a where a.id = ${approvalId}
  `;
  if (!approval || approval.decision !== "approved" || approval.projectId !== input.projectId) {
    return { ok: false, code: "publication_not_approved", reason: "The referenced approval is missing, not approved, or belongs to another client." };
  }
  const [draft] = await sql`
    select n.output from node_runs n
    where n.workflow_run_id = ${approval.workflowRunId} and n.node_key = 'cms_draft' and n.state = 'succeeded'
    order by n.finished_at desc limit 1
  `;
  const out = (draft?.output ?? {}) as { data?: { externalId?: unknown; id?: unknown } };
  const draftId = String(out.data?.externalId ?? out.data?.id ?? "");
  const [canonical] = await sql`
    select n.output from node_runs n
    where n.workflow_run_id = ${approval.workflowRunId} and n.node_key = 'canonical_content' and n.state = 'succeeded'
    order by n.finished_at desc limit 1
  `;
  const draftAsset = String((canonical?.output as { contentAssetId?: unknown } | undefined)?.contentAssetId ?? "");
  if (!draftId || draftId !== externalId || draftAsset !== assetId) {
    return { ok: false, code: "publication_draft_mismatch", reason: "The CMS draft being published was not created from this approved asset in the approved run." };
  }
  return null;
}

export async function checkPublishable(input: {
  capability: string;
  projectId: string | null;
  payload: Record<string, unknown>;
}): Promise<PublishGateResult> {
  const assetId = typeof input.payload.contentAssetId === "string" ? input.payload.contentAssetId : null;
  const uuid = /^[0-9a-f-]{36}$/i;
  const [asset] = assetId && uuid.test(assetId)
    ? await sql`select id, project_id, status from content_assets where id = ${assetId}`
    : [];
  const [latest] = asset
    ? await sql`select body, verification from content_versions where asset_id = ${asset.id} order by version desc limit 1`
    : [];
  const decision = decidePublishable({
    ...input,
    asset: asset ? { id: asset.id as string, projectId: asset.projectId as string, status: asset.status as string } : null,
    latestVersion: latest ? { body: latest.body as string, verification: latest.verification } : null,
  });
  if (!decision.ok || input.capability !== "cms.publish_approved_asset") return decision;
  return (await publicationBinding(input)) ?? decision;
}
