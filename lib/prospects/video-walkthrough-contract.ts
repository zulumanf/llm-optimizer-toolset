/**
 * Video walkthrough input contract (specs 137/138). Pure, no I/O, no renderer.
 *
 * The video plugs into the same foundation as the email and the report: it
 * receives an evidence package (the frozen snapshot's hash), a fact
 * manifest, approved evidence, an approved first action and versions — and
 * NOTHING it could recompute. Scenes are typed props compiled from the
 * manifest; every factual script line cites the fact ids it states; the
 * connective copy is a versioned constant (no model writes the script).
 * QA validates the props and the text, not pixels.
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
import { prospectReference, type ProspectEntityType } from "@/lib/prospects/followup-templates";

export const VIDEO_CONTRACT_VERSION = "video-walkthrough-contract-v1";
/** v2 (2026-09-11): production line reads "came in at <display>" — the
 * volume display already carries "closed", so v1 narrated "closed $X closed". */
export const VIDEO_SCRIPT_TEMPLATE_VERSION = "video-script-v2";
/** The ONLY entity types the canonical manifest can hold (the RealTrends
 * record's entity_type, resolved upstream in `prospectEntityType`). Anything
 * else — including a brokerage until the manifest learns it — fails closed
 * here with `entity_unknown`; the video never resolves an entity itself. */
export const VIDEO_ENTITY_TYPES: readonly ProspectEntityType[] = ["team", "individual"];

/** Approved examples the ONE template narrates (the rest stay in the report). */
export const VIDEO_MAX_EXAMPLES = 2;

/** Connective copy: fixed, versioned sentences with no figures. A model
 * never writes them; the semantic reviewer only judges them. */
export const VIDEO_CONNECTIVE_COPY = {
  version: "video-connective-v1",
  interpretation:
    "That is the gap I wanted you to see. It does not say one business is better than the other; it shows the difference between verified production and how often the model recommended each one.",
  exampleLead: "Here is one example of what that looked like.",
  closeVerify: "I put the full questions and evidence in your private report so you can verify everything yourself",
  closeReply: "If anything jumps out, just reply to the email.",
} as const;

export interface ApprovedExample { id: string; question: string; quote: string }
export interface ApprovedFirstAction { id: string; title: string; body: string }

export interface VideoWalkthroughInput {
  prospect: { name: string; firstName: string; entityType: ProspectEntityType };
  market: string;
  evidencePackageId: string;
  factManifestId: string;
  manifest: FactManifest;
  approvedExamples: ApprovedExample[];
  approvedFirstAction: ApprovedFirstAction | null;
  reportArtifact: { artifactId: string; revision: number };
  templateVersion: string;
  introAssetVersion: string;
  /** Transcript of the recorded founder intro (the asset registry's, never typed by a caller at run time). */
  introTranscript?: string;
  voiceVersion: string;
}

export type VideoScene =
  | { kind: "FounderIntroScene"; introAssetVersion: string }
  | { kind: "ProspectTitleScene"; prospectName: string; market: string }
  | { kind: "ProductionComparisonScene"; prospectName: string; prospectVolume: string; competitorName: string; competitorVolume: string; productionYear: string; metric: string; productionRatio: string }
  | { kind: "RecommendationComparisonScene"; prospectName: string; prospectRecommendations: string; competitorName: string; competitorRecommendations: string; denominator: string; recommendationMultiple: string }
  | { kind: "MismatchInterpretationScene"; summary: string; connective: string }
  | { kind: "ExampleEvidenceScene"; exampleId: string; question: string; quote: string }
  | { kind: "FirstActionScene"; actionId: string; title: string; body: string }
  | { kind: "ClosingScene"; prospectFirstName: string };

export type Narration = "recorded" | "tts";
export interface ScriptLine extends CompiledSentence { sceneIndex: number; approvedIds: string[]; narration: Narration }

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
  scriptTemplateVersion: string;
  scenes: VideoScene[];
  script: ScriptLine[];
  videoFactManifest: VideoFactManifest;
  /** Hash over scenes + script + versions: the artifact content hash. */
  contentHash: string;
  /** Hash over the script text alone: the script revision TTS and captions bind to. */
  scriptHash: string;
}

const disp = (m: FactManifest, id: FactId): string => m.facts[id].display;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

export function scriptHashOf(script: readonly ScriptLine[]): string {
  return sha(canonicalJson({ v: VIDEO_SCRIPT_TEMPLATE_VERSION, lines: script.map((l) => ({ i: l.sceneIndex, t: l.text, n: l.narration })) }));
}

/** The examples the ONE template narrates: the first VIDEO_MAX_EXAMPLES by id (deterministic). */
export function selectVideoExamples(examples: readonly ApprovedExample[]): ApprovedExample[] {
  return [...examples].sort((a, b) => a.id.localeCompare(b.id)).slice(0, VIDEO_MAX_EXAMPLES);
}

/** Compile scenes and the script from the manifest. Deterministic. */
export function compileVideoWalkthrough(i: VideoWalkthroughInput): CompiledVideo {
  const m = i.manifest;
  const summary = validatedSummarySentence(m);
  const examples = selectVideoExamples(i.approvedExamples);
  const entity = i.prospect.entityType;
  const ref = prospectReference(entity);
  const were = entity === "team" ? "was" : "were";
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
    { kind: "MismatchInterpretationScene", summary: summary.text, connective: VIDEO_CONNECTIVE_COPY.interpretation },
    ...examples.map((e): VideoScene => ({ kind: "ExampleEvidenceScene", exampleId: e.id, question: e.question, quote: e.quote })),
    ...(i.approvedFirstAction ? [{ kind: "FirstActionScene", actionId: i.approvedFirstAction.id, title: i.approvedFirstAction.title, body: i.approvedFirstAction.body } as VideoScene] : []),
    { kind: "ClosingScene", prospectFirstName: i.prospect.firstName },
  ];
  const line = (sceneIndex: number, text: string, factIds: FactId[], approvedIds: string[] = [], narration: Narration = "tts"): ScriptLine => ({ sceneIndex, text, factIds, approvedIds, narration });
  const prospectCount = m.facts.FACT_PROSPECT_RECOMMENDATIONS.value === 0
    ? `${ref} ${were} not recommended in any of them`
    : `${ref} ${were} recommended ${disp(m, "FACT_PROSPECT_RECOMMENDATIONS")} times`;
  const exampleStart = 5;
  const script: ScriptLine[] = [
    line(0, i.introTranscript ?? "", [], [], "recorded"),
    line(1, `${i.prospect.firstName}, here is what stood out in the ${disp(m, "FACT_MARKET")} results.`, ["FACT_MARKET"]),
    line(2, `On the ${disp(m, "FACT_PRODUCTION_YEAR")} record for ${disp(m, "FACT_PRODUCTION_METRIC")}, ${ref} came in at ${disp(m, "FACT_PROSPECT_VOLUME")}, and ${disp(m, "FACT_COMPETITOR_NAME")} came in at ${disp(m, "FACT_COMPETITOR_VOLUME")}.`,
      ["FACT_PRODUCTION_YEAR", "FACT_PRODUCTION_METRIC", "FACT_PROSPECT_VOLUME", "FACT_COMPETITOR_NAME", "FACT_COMPETITOR_VOLUME"]),
    line(3, `But when we put the same ${disp(m, "FACT_DENOMINATOR")} questions to ${disp(m, "FACT_PROVIDER")}, ${prospectCount}, and ${disp(m, "FACT_COMPETITOR_NAME")} was recommended ${disp(m, "FACT_COMPETITOR_RECOMMENDATIONS")} times.`,
      ["FACT_DENOMINATOR", "FACT_PROVIDER", "FACT_PROSPECT_RECOMMENDATIONS", "FACT_COMPETITOR_NAME", "FACT_COMPETITOR_RECOMMENDATIONS"]),
    line(4, `${summary.text} ${VIDEO_CONNECTIVE_COPY.interpretation}`, summary.factIds),
    ...examples.map((e, k) => line(exampleStart + k, `${k === 0 ? `${VIDEO_CONNECTIVE_COPY.exampleLead} ` : "Another one. "}The question was: "${e.question}"`, [], [e.id])),
    ...(i.approvedFirstAction ? [line(exampleStart + examples.length, `The first thing I would look at is ${i.approvedFirstAction.title}.`, [], [i.approvedFirstAction.id])] : []),
    line(scenes.length - 1, `${VIDEO_CONNECTIVE_COPY.closeVerify}, ${i.prospect.firstName}. ${VIDEO_CONNECTIVE_COPY.closeReply}`, []),
  ];
  const videoFactManifest: VideoFactManifest = {
    prospectName: disp(m, "FACT_PROSPECT_NAME"), market: disp(m, "FACT_MARKET"), competitorName: disp(m, "FACT_COMPETITOR_NAME"),
    prospectVolume: disp(m, "FACT_PROSPECT_VOLUME"), competitorVolume: disp(m, "FACT_COMPETITOR_VOLUME"),
    prospectRecommendations: disp(m, "FACT_PROSPECT_RECOMMENDATIONS"), competitorRecommendations: disp(m, "FACT_COMPETITOR_RECOMMENDATIONS"),
    denominator: disp(m, "FACT_DENOMINATOR"), productionRatio: disp(m, "FACT_PRODUCTION_RATIO"), recommendationMultiple: disp(m, "FACT_RECOMMENDATION_MULTIPLE"),
    approvedExampleIds: examples.map((e) => e.id), approvedFirstActionId: i.approvedFirstAction?.id ?? null,
    sourceEvidenceHash: m.evidenceHash, manifestHash: m.manifestHash,
  };
  const scriptHash = scriptHashOf(script);
  const contentHash = sha(canonicalJson({ scenes, script, v: VIDEO_CONTRACT_VERSION, s: VIDEO_SCRIPT_TEMPLATE_VERSION, t: i.templateVersion, intro: i.introAssetVersion, voice: i.voiceVersion }));
  return { contractVersion: VIDEO_CONTRACT_VERSION, scriptTemplateVersion: VIDEO_SCRIPT_TEMPLATE_VERSION, scenes, script, videoFactManifest, contentHash, scriptHash };
}

/** The TTS units: one segment per scene, narrated lines only (the recorded
 * intro is a clip, never synthesized). */
export interface NarrationSegment { index: number; sceneIndex: number; text: string }
export function narrationSegments(v: CompiledVideo): NarrationSegment[] {
  const bySceneIndex = new Map<number, string[]>();
  for (const l of v.script) if (l.narration === "tts" && l.text.trim()) bySceneIndex.set(l.sceneIndex, [...(bySceneIndex.get(l.sceneIndex) ?? []), l.text]);
  return [...bySceneIndex.entries()].sort((a, b) => a[0] - b[0]).map(([sceneIndex, lines], index) => ({ index, sceneIndex, text: lines.join(" ") }));
}

const NUMERIC_SCENE_KINDS = new Set<VideoScene["kind"]>(["ProductionComparisonScene", "RecommendationComparisonScene", "MismatchInterpretationScene"]);

/** Machine QA over the props: every scene value and every script figure is
 * a manifest figure; approved ids are the manifest's; no internal field
 * reaches a scene. This is the factual QA — not OCR. */
export function assertVideoMatchesManifest(v: CompiledVideo, m: FactManifest, input: Pick<VideoWalkthroughInput, "approvedExamples" | "approvedFirstAction">): ManifestAssertionIssue[] {
  const issues: ManifestAssertionIssue[] = [];
  const approvedIds = new Set(m.facts.FACT_APPROVED_EXAMPLE_IDS.value as string[]);
  for (const [k, s] of v.scenes.entries()) {
    const { kind, ...props } = s;
    issues.push(...assertNoInternalFields(props as Record<string, unknown>).map((x) => ({ ...x, detail: `${kind}: ${x.detail}` })));
    if (NUMERIC_SCENE_KINDS.has(kind)) {
      const text = Object.values(props).join(" ");
      issues.push(...assertTextNumbersManifested(text, m).map((x) => ({ ...x, detail: `${kind}[${k}]: ${x.detail}` })));
    }
    if (kind === "ExampleEvidenceScene" && !approvedIds.has(s.exampleId)) issues.push({ check: "unapproved_example", detail: `${s.exampleId} is not an approved example in the manifest` });
    if (kind === "FirstActionScene" && s.actionId !== m.facts.FACT_APPROVED_FIRST_ACTION_ID.value) issues.push({ check: "unapproved_action", detail: `${s.actionId} is not the approved first action` });
  }
  for (const line of v.script) {
    if (line.narration === "recorded") continue;
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

/** Vocabulary the walkthrough may never carry (pricing, guarantees, hard
 * CTAs, consumer-ChatGPT overclaims, internal terms). Case-insensitive. */
export const VIDEO_BANNED_PATTERNS: { code: string; re: RegExp }[] = [
  { code: "pricing", re: /\$\s?\d[\d,]*(?:\.\d+)?\s*(?:\/|per)\s*(?:mo|month)|\bper month\b|\bpricing\b|\bcontract\b|\bpackage\b|\bdiscount\b|\bretainer\b/i },
  { code: "guarantee", re: /\bguarantee[sd]?\b|\bpromise\b|\bwill rank\b|\brank(?:ed)? #?1\b|\bnumber one\b/i },
  { code: "hard_cta", re: /\bbook a call\b|\bschedule a call\b|\bsign up\b|\bbuy now\b|\bact now\b/i },
  { code: "consumer_chatgpt", re: /\bChatGPT (?:recommends|says|thinks|prefers|picks)\b/i },
  { code: "internal_term", re: /\bmanifest\b|\bhandoff\b|\bshadow mode\b|\bcanary\b|\bbenchmark run\b|\bqa\b|\bsuppress/i },
  { code: "unresolved_placeholder", re: /\{[a-z_]+\}|\bundefined\b|\bnull\b|\bNaN\b/i },
  /** A zero prospect count must never surface as an infinite multiple. */
  { code: "zero_case", re: /∞|\binfinit(?:y|e|ely)\b|\bInfinityx\b/i },
];

/** Scene props a viewer sees (ids and asset versions are bindings, not text). */
export function displayedSceneText(v: CompiledVideo): string {
  return v.scenes
    .flatMap((s) => Object.entries(s).filter(([k, val]) => typeof val === "string" && k !== "kind" && !/Id$/.test(k) && k !== "introAssetVersion").map(([, val]) => val as string))
    .join("\n");
}

/** Deterministic script QA before any model reads it: placeholders resolved,
 * identities present, denominator stated, figures manifested, approvals
 * frozen, banned vocabulary absent, manifest current. */
export function assertVideoScriptReleasable(v: CompiledVideo, input: VideoWalkthroughInput, current: FactManifest | null = null): ManifestAssertionIssue[] {
  const m = input.manifest;
  const issues = assertVideoMatchesManifest(v, m, input);
  const narrated = v.script.filter((l) => l.narration === "tts");
  const text = narrated.map((l) => l.text).join("\n");
  const required: FactId[] = ["FACT_PROSPECT_NAME", "FACT_MARKET", "FACT_PROSPECT_VOLUME", "FACT_COMPETITOR_NAME", "FACT_COMPETITOR_VOLUME", "FACT_PRODUCTION_YEAR", "FACT_DENOMINATOR", "FACT_PROVIDER"];
  for (const id of required) if (!m.facts[id].display.trim()) issues.push({ check: "missing_fact_display", detail: `${id} has no display value` });
  // Entity identity is the manifest's, and only the canonical set renders:
  // an unknown type never becomes "your team" by default.
  const manifestEntity = m.facts.FACT_PROSPECT_ENTITY_TYPE.value;
  if (!(VIDEO_ENTITY_TYPES as readonly unknown[]).includes(manifestEntity)) issues.push({ check: "entity_unknown", detail: `manifest entity type ${JSON.stringify(manifestEntity)} is not one of ${VIDEO_ENTITY_TYPES.join("/")}` });
  else if (input.prospect.entityType !== manifestEntity) issues.push({ check: "entity_mismatch", detail: `input says ${input.prospect.entityType}; the manifest says ${String(manifestEntity)}` });
  const sceneText = displayedSceneText(v);
  for (const { code, re } of VIDEO_BANNED_PATTERNS) {
    const hit = text.match(re);
    if (hit) issues.push({ check: `banned_${code}`, detail: `"${hit[0]}"` });
    const onScreen = sceneText.match(re);
    if (onScreen) issues.push({ check: `banned_${code}_on_screen`, detail: `"${onScreen[0]}"` });
  }
  const has = (needle: string): boolean => text.includes(needle);
  if (!has(input.prospect.firstName)) issues.push({ check: "prospect_missing", detail: "first name absent from the narration" });
  if (!has(m.facts.FACT_COMPETITOR_NAME.display)) issues.push({ check: "competitor_missing", detail: "competitor name absent from the narration" });
  if (!has(m.facts.FACT_MARKET.display)) issues.push({ check: "market_missing", detail: "market absent from the narration" });
  if (!has(`${m.facts.FACT_DENOMINATOR.display} questions`)) issues.push({ check: "denominator_missing", detail: "denominator absent from the narration" });
  const approved = new Set(m.facts.FACT_APPROVED_EXAMPLE_IDS.value as string[]);
  for (const e of input.approvedExamples) if (!approved.has(e.id)) issues.push({ check: "unapproved_example", detail: `${e.id} is not in the manifest's approved examples` });
  if (input.approvedFirstAction && input.approvedFirstAction.id !== m.facts.FACT_APPROVED_FIRST_ACTION_ID.value) issues.push({ check: "unapproved_action", detail: `${input.approvedFirstAction.id} is not the approved first action` });
  if (v.scriptTemplateVersion !== VIDEO_SCRIPT_TEMPLATE_VERSION) issues.push({ check: "script_template_version", detail: `${v.scriptTemplateVersion} is not the current script template` });
  if (current && current.manifestHash !== m.manifestHash) issues.push({ check: "stale_manifest", detail: "the fact manifest has been superseded" });
  return issues;
}

/** A pending video artifact is stale when its manifest is no longer the
 * current one (correction, recount, denominator change). Time alone never
 * invalidates. */
export function videoArtifactStale(artifact: { manifestHash: string }, current: FactManifest): { stale: boolean; reason: string | null } {
  return artifact.manifestHash === current.manifestHash ? { stale: false, reason: null } : { stale: true, reason: "fact manifest superseded" };
}
