/**
 * Video walkthrough input contract (spec 137). Pure, no I/O, no renderer.
 *
 * The future video pipeline plugs into the same foundation as the email
 * and the report: it receives an evidence package (the frozen snapshot's
 * hash), a fact manifest, approved evidence, an approved first action and
 * versions — and NOTHING it could recompute. Scenes are typed props
 * compiled from the manifest; every factual script line cites the fact
 * ids it states. QA validates the props, not pixels.
 */
import { createHash } from "node:crypto";
import {
  assertNoInternalFields,
  assertTextNumbersManifested,
  canonicalJson,
  validatedSummarySentence,
  type CompiledSentence,
  type FactId,
  type FactManifest,
  type ManifestAssertionIssue,
} from "@/lib/prospects/fact-manifest";

export const VIDEO_CONTRACT_VERSION = "video-walkthrough-contract-v1";
export const VIDEO_SCRIPT_TEMPLATE_VERSION = "video-script-v1";

export interface ApprovedExample { id: string; question: string; quote: string }
export interface ApprovedFirstAction { id: string; title: string; body: string }

export interface VideoWalkthroughInput {
  prospect: { name: string; firstName: string; entityType: "individual" | "team" };
  market: string;
  evidencePackageId: string;
  factManifestId: string;
  manifest: FactManifest;
  approvedExamples: ApprovedExample[];
  approvedFirstAction: ApprovedFirstAction | null;
  reportArtifact: { artifactId: string; revision: number };
  templateVersion: string;
  introAssetVersion: string;
  voiceVersion: string;
}

export type VideoScene =
  | { kind: "FounderIntroScene"; introAssetVersion: string }
  | { kind: "ProspectTitleScene"; prospectName: string; market: string }
  | { kind: "ProductionComparisonScene"; prospectName: string; prospectVolume: string; competitorName: string; competitorVolume: string; productionYear: string; metric: string; productionRatio: string }
  | { kind: "RecommendationComparisonScene"; prospectName: string; prospectRecommendations: string; competitorName: string; competitorRecommendations: string; denominator: string; recommendationMultiple: string }
  | { kind: "ExampleEvidenceScene"; exampleId: string; question: string; quote: string }
  | { kind: "FirstActionScene"; actionId: string; title: string; body: string }
  | { kind: "ClosingScene"; prospectFirstName: string };

export interface ScriptLine extends CompiledSentence { sceneIndex: number; approvedIds: string[] }

export interface VideoFactManifest {
  prospectName: string; market: string; competitorName: string;
  prospectVolume: string; competitorVolume: string;
  prospectRecommendations: string; competitorRecommendations: string; denominator: string;
  productionRatio: string; recommendationMultiple: string;
  approvedExampleIds: string[]; approvedFirstActionId: string | null;
  sourceEvidenceHash: string; manifestHash: string;
}

export interface CompiledVideo {
  contractVersion: string;
  scenes: VideoScene[];
  script: ScriptLine[];
  videoFactManifest: VideoFactManifest;
  /** Hash over scenes + script: the artifact content hash. */
  contentHash: string;
}

const disp = (m: FactManifest, id: FactId): string => m.facts[id].display;

/** Compile scenes and the script from the manifest. Deterministic. */
export function compileVideoWalkthrough(i: VideoWalkthroughInput): CompiledVideo {
  const m = i.manifest;
  const summary = validatedSummarySentence(m);
  const scenes: VideoScene[] = [
    { kind: "FounderIntroScene", introAssetVersion: i.introAssetVersion },
    { kind: "ProspectTitleScene", prospectName: disp(m, "FACT_PROSPECT_NAME"), market: disp(m, "FACT_MARKET") },
    {
      kind: "ProductionComparisonScene",
      prospectName: disp(m, "FACT_PROSPECT_NAME"), prospectVolume: disp(m, "FACT_PROSPECT_VOLUME"),
      competitorName: disp(m, "FACT_COMPETITOR_NAME"), competitorVolume: disp(m, "FACT_COMPETITOR_VOLUME"),
      productionYear: disp(m, "FACT_PRODUCTION_YEAR"), metric: disp(m, "FACT_PRODUCTION_METRIC"), productionRatio: disp(m, "FACT_PRODUCTION_RATIO"),
    },
    {
      kind: "RecommendationComparisonScene",
      prospectName: disp(m, "FACT_PROSPECT_NAME"), prospectRecommendations: disp(m, "FACT_PROSPECT_RECOMMENDATIONS"),
      competitorName: disp(m, "FACT_COMPETITOR_NAME"), competitorRecommendations: disp(m, "FACT_COMPETITOR_RECOMMENDATIONS"),
      denominator: disp(m, "FACT_DENOMINATOR"), recommendationMultiple: disp(m, "FACT_RECOMMENDATION_MULTIPLE"),
    },
    ...i.approvedExamples.map((e): VideoScene => ({ kind: "ExampleEvidenceScene", exampleId: e.id, question: e.question, quote: e.quote })),
    ...(i.approvedFirstAction ? [{ kind: "FirstActionScene", actionId: i.approvedFirstAction.id, title: i.approvedFirstAction.title, body: i.approvedFirstAction.body } as VideoScene] : []),
    { kind: "ClosingScene", prospectFirstName: i.prospect.firstName },
  ];
  const ref = i.prospect.entityType === "team" ? "your team" : "you";
  const script: ScriptLine[] = [
    { sceneIndex: 1, text: `${i.prospect.firstName}, here is what I found for ${disp(m, "FACT_MARKET")}.`, factIds: ["FACT_MARKET"], approvedIds: [] },
    {
      sceneIndex: 2,
      text: `On the RealTrends ${disp(m, "FACT_PRODUCTION_YEAR")} record for ${disp(m, "FACT_PRODUCTION_METRIC")}, ${ref} closed ${disp(m, "FACT_PROSPECT_VOLUME")}; ${disp(m, "FACT_COMPETITOR_NAME")} closed ${disp(m, "FACT_COMPETITOR_VOLUME")}.`,
      factIds: ["FACT_PRODUCTION_YEAR", "FACT_PRODUCTION_METRIC", "FACT_PROSPECT_VOLUME", "FACT_COMPETITOR_NAME", "FACT_COMPETITOR_VOLUME"], approvedIds: [],
    },
    { sceneIndex: 3, text: summary.text, factIds: summary.factIds, approvedIds: [] },
    ...i.approvedExamples.map((e, k): ScriptLine => ({ sceneIndex: 4 + k, text: `One of the questions: ${e.question}`, factIds: [], approvedIds: [e.id] })),
    ...(i.approvedFirstAction ? [{ sceneIndex: 4 + i.approvedExamples.length, text: `The first thing I would look at: ${i.approvedFirstAction.title}.`, factIds: [], approvedIds: [i.approvedFirstAction.id] } as ScriptLine] : []),
    { sceneIndex: scenes.length - 1, text: `The full side-by-side is in your private report, ${i.prospect.firstName}.`, factIds: [], approvedIds: [] },
  ];
  const videoFactManifest: VideoFactManifest = {
    prospectName: disp(m, "FACT_PROSPECT_NAME"), market: disp(m, "FACT_MARKET"), competitorName: disp(m, "FACT_COMPETITOR_NAME"),
    prospectVolume: disp(m, "FACT_PROSPECT_VOLUME"), competitorVolume: disp(m, "FACT_COMPETITOR_VOLUME"),
    prospectRecommendations: disp(m, "FACT_PROSPECT_RECOMMENDATIONS"), competitorRecommendations: disp(m, "FACT_COMPETITOR_RECOMMENDATIONS"),
    denominator: disp(m, "FACT_DENOMINATOR"), productionRatio: disp(m, "FACT_PRODUCTION_RATIO"), recommendationMultiple: disp(m, "FACT_RECOMMENDATION_MULTIPLE"),
    approvedExampleIds: i.approvedExamples.map((e) => e.id), approvedFirstActionId: i.approvedFirstAction?.id ?? null,
    sourceEvidenceHash: m.evidenceHash, manifestHash: m.manifestHash,
  };
  const contentHash = createHash("sha256").update(canonicalJson({ scenes, script, v: VIDEO_CONTRACT_VERSION, t: i.templateVersion, intro: i.introAssetVersion, voice: i.voiceVersion })).digest("hex");
  return { contractVersion: VIDEO_CONTRACT_VERSION, scenes, script, videoFactManifest, contentHash };
}

/** Machine QA over the props: every scene value and every script figure is
 * a manifest figure; approved ids are the manifest's; no internal field
 * reaches a scene. This is the factual QA — not OCR. */
export function assertVideoMatchesManifest(v: CompiledVideo, m: FactManifest, input: Pick<VideoWalkthroughInput, "approvedExamples" | "approvedFirstAction">): ManifestAssertionIssue[] {
  const issues: ManifestAssertionIssue[] = [];
  const approvedIds = new Set(m.facts.FACT_APPROVED_EXAMPLE_IDS.value as string[]);
  for (const [k, s] of v.scenes.entries()) {
    const { kind, ...props } = s;
    issues.push(...assertNoInternalFields(props as Record<string, unknown>).map((x) => ({ ...x, detail: `${kind}: ${x.detail}` })));
    if (kind === "ProductionComparisonScene" || kind === "RecommendationComparisonScene") {
      const text = Object.values(props).join(" ");
      issues.push(...assertTextNumbersManifested(text, m).map((x) => ({ ...x, detail: `${kind}[${k}]: ${x.detail}` })));
    }
    if (kind === "ExampleEvidenceScene" && !approvedIds.has(s.exampleId)) issues.push({ check: "unapproved_example", detail: `${s.exampleId} is not an approved example in the manifest` });
    if (kind === "FirstActionScene" && s.actionId !== m.facts.FACT_APPROVED_FIRST_ACTION_ID.value) issues.push({ check: "unapproved_action", detail: `${s.actionId} is not the approved first action` });
  }
  for (const line of v.script) {
    const quoted = [...input.approvedExamples.map((e) => e.question + " " + e.quote), input.approvedFirstAction ? input.approvedFirstAction.title + " " + input.approvedFirstAction.body : ""];
    const extra = line.approvedIds.length ? quoted : [];
    const bad = assertTextNumbersManifested(line.text, m, extra);
    if (bad.length) issues.push({ check: "script_unmanifested_number", detail: `scene ${line.sceneIndex}: ${bad[0]!.detail}` });
    if (line.factIds.length === 0 && line.approvedIds.length === 0 && /\d/.test(line.text)) {
      issues.push({ check: "script_untraced_claim", detail: `scene ${line.sceneIndex}: a figure with no fact or approval id` });
    }
  }
  if (v.videoFactManifest.manifestHash !== m.manifestHash) issues.push({ check: "manifest_hash", detail: "video fact manifest is from a different fact manifest" });
  return issues;
}

/** A pending video artifact is stale when its manifest is no longer the
 * current one (correction, recount, denominator change). Time alone never
 * invalidates. */
export function videoArtifactStale(artifact: { manifestHash: string }, current: FactManifest): { stale: boolean; reason: string | null } {
  return artifact.manifestHash === current.manifestHash ? { stale: false, reason: null } : { stale: true, reason: "fact manifest superseded" };
}
