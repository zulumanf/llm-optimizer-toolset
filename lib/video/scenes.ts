/**
 * Purpose-built scenes (spec 138): typed props from the compiled video →
 * one static 1920×1080 HTML frame each. No scene reads anything but its
 * props. Clean typography, large numbers, generous space, the report's
 * neutral palette; no gradients, stock footage or animation.
 *
 * Text safety: font sizes are chosen from string length by fixed rules,
 * long strings wrap inside bounded boxes, and `sceneLayoutIssues` flags
 * what no rule can fit. The rasterizer measures real overflow on top.
 */
import type { VideoScene } from "@/lib/prospects/video-walkthrough-contract";
import { VIDEO_FORMAT } from "@/lib/video/constants";

export const SCENE_FONT_STACK = `"Inter", "Helvetica Neue", Helvetica, Arial, system-ui, sans-serif`;
/** Report palette (app/globals.css): near-black ink, muted grey, hairline. */
export const SCENE_COLORS = { bg: "#ffffff", ink: "#111111", muted: "#6b6b6b", rule: "#e5e5e5", soft: "#f5f5f5" } as const;
export const BRAND_WORDMARK = "Recommended First";

/** Average glyph width as a fraction of the font size (sans, mixed case). */
const AVG_CHAR_EM = 0.56;
export interface FitRule { maxWidthPx: number; maxLines: number; maxPx: number; minPx: number }

/** Largest size at which the text fits the box within maxLines, by estimate. */
export function fitFontSize(text: string, rule: FitRule): number {
  const len = Math.max(1, text.length);
  for (let px = rule.maxPx; px >= rule.minPx; px -= 2) {
    const charsPerLine = Math.floor(rule.maxWidthPx / (px * AVG_CHAR_EM));
    if (charsPerLine <= 0) continue;
    const lines = Math.ceil(len / charsPerLine);
    if (lines <= rule.maxLines) return px;
  }
  return rule.minPx;
}

export function estimatedLines(text: string, px: number, maxWidthPx: number): number {
  const charsPerLine = Math.max(1, Math.floor(maxWidthPx / (px * AVG_CHAR_EM)));
  return Math.ceil(Math.max(1, text.length) / charsPerLine);
}

export const FIT = {
  title: { maxWidthPx: 1600, maxLines: 2, maxPx: 104, minPx: 56 },
  name: { maxWidthPx: 760, maxLines: 3, maxPx: 44, minPx: 24 },
  bigNumber: { maxWidthPx: 760, maxLines: 1, maxPx: 168, minPx: 72 },
  body: { maxWidthPx: 1500, maxLines: 4, maxPx: 52, minPx: 30 },
  quote: { maxWidthPx: 1500, maxLines: 5, maxPx: 44, minPx: 26 },
} as const satisfies Record<string, FitRule>;

export interface SceneLayoutIssue { sceneIndex: number; field: string; detail: string }

/** What the fit rules cannot save: a value still exceeding its lines at the
 * smallest size. Deterministic, pre-render. */
export function sceneLayoutIssues(scene: VideoScene, sceneIndex: number): SceneLayoutIssue[] {
  const issues: SceneLayoutIssue[] = [];
  const check = (field: string, text: string, rule: FitRule): void => {
    const px = fitFontSize(text, rule);
    if (estimatedLines(text, px, rule.maxWidthPx) > rule.maxLines) issues.push({ sceneIndex, field, detail: `${text.length} chars cannot fit ${rule.maxLines} line(s) at ${rule.minPx}px` });
  };
  switch (scene.kind) {
    case "ProspectTitleScene": check("prospectName", scene.prospectName, FIT.title); check("market", scene.market, FIT.body); break;
    case "ProductionComparisonScene":
      check("prospectName", scene.prospectName, FIT.name); check("competitorName", scene.competitorName, FIT.name);
      check("prospectVolume", scene.prospectVolume, FIT.bigNumber); check("competitorVolume", scene.competitorVolume, FIT.bigNumber); break;
    case "RecommendationComparisonScene":
      check("prospectName", scene.prospectName, FIT.name); check("competitorName", scene.competitorName, FIT.name);
      check("prospectRecommendations", scene.prospectRecommendations, FIT.bigNumber); check("competitorRecommendations", scene.competitorRecommendations, FIT.bigNumber); break;
    case "MismatchInterpretationScene": check("summary", scene.summary, FIT.body); break;
    case "ExampleEvidenceScene": check("question", scene.question, FIT.body); check("quote", scene.quote, FIT.quote); break;
    case "FirstActionScene": check("title", scene.title, FIT.body); check("body", scene.body, FIT.quote); break;
    case "ClosingScene": check("prospectFirstName", scene.prospectFirstName, FIT.title); break;
    case "FounderIntroScene": break;
  }
  return issues;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const fitted = (text: string, rule: FitRule, extra = ""): string =>
  `<div data-fit style="font-size:${fitFontSize(text, rule)}px;max-width:${rule.maxWidthPx}px;overflow-wrap:anywhere;${extra}">${escapeHtml(text)}</div>`;

function frame(inner: string, opts: { footer?: string } = {}): string {
  const { width, height } = VIDEO_FORMAT;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:${width}px;height:${height}px;overflow:hidden;background:${SCENE_COLORS.bg};color:${SCENE_COLORS.ink};font-family:${SCENE_FONT_STACK};-webkit-font-smoothing:antialiased}
.stage{position:relative;width:${width}px;height:${height}px;box-sizing:border-box;padding:120px 160px}
.brand{position:absolute;top:56px;left:160px;font-size:22px;letter-spacing:0.12em;text-transform:uppercase;color:${SCENE_COLORS.muted};font-weight:600}
.eyebrow{font-size:26px;letter-spacing:0.08em;text-transform:uppercase;color:${SCENE_COLORS.muted};font-weight:600;margin-bottom:36px}
.rule{height:2px;background:${SCENE_COLORS.rule};margin:48px 0}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:80px;align-items:start}
.col .label{color:${SCENE_COLORS.muted};font-size:28px;margin-bottom:12px;font-weight:500}
.col .name{font-weight:600;line-height:1.15;min-height:110px}
.col .num{font-weight:700;line-height:1;letter-spacing:-0.02em;margin-top:28px;white-space:nowrap}
.col .sub{color:${SCENE_COLORS.muted};font-size:28px;margin-top:20px}
.h1{font-weight:700;line-height:1.05;letter-spacing:-0.02em}
.body{line-height:1.35;font-weight:500}
.quote{line-height:1.4;color:${SCENE_COLORS.ink};background:${SCENE_COLORS.soft};padding:40px 48px;border-left:6px solid ${SCENE_COLORS.ink};margin-top:40px}
.footer{position:absolute;bottom:64px;left:160px;right:160px;color:${SCENE_COLORS.muted};font-size:24px}
</style></head><body><div class="stage"><div class="brand">${BRAND_WORDMARK}</div>${inner}${opts.footer ? `<div class="footer">${escapeHtml(opts.footer)}</div>` : ""}</div></body></html>`;
}

function comparison(eyebrow: string, left: { name: string; num: string; sub: string }, right: { name: string; num: string; sub: string }, footer: string): string {
  const col = (c: { name: string; num: string; sub: string }, label: string): string =>
    `<div class="col"><div class="label">${label}</div><div class="name">${fitted(c.name, FIT.name)}</div><div class="num">${fitted(c.num, FIT.bigNumber)}</div><div class="sub">${escapeHtml(c.sub)}</div></div>`;
  return frame(`<div class="eyebrow">${escapeHtml(eyebrow)}</div><div class="cols">${col(left, "You")}${col(right, "Competitor")}</div>`, { footer });
}

/** One scene → one full HTML document for the rasterizer. */
export function renderSceneHtml(scene: VideoScene): string {
  switch (scene.kind) {
    case "FounderIntroScene":
      // Never rasterized: the recorded clip is the scene. A neutral card
      // stands in only if the composer ever needs a still.
      return frame(`<div class="h1" style="font-size:72px">Francisco</div>`);
    case "ProspectTitleScene":
      return frame(`<div class="eyebrow">Private AI recommendation results</div><div class="h1">${fitted(scene.prospectName, FIT.title)}</div><div class="rule"></div><div class="body">${fitted(scene.market, FIT.body)}</div>`);
    case "ProductionComparisonScene":
      return comparison(`Verified production · ${scene.productionYear} ${scene.metric}`, { name: scene.prospectName, num: scene.prospectVolume, sub: "" }, { name: scene.competitorName, num: scene.competitorVolume, sub: scene.productionRatio ? `${scene.productionRatio} of your volume` : "" }, "Source: verified production record for the period shown.");
    case "RecommendationComparisonScene":
      return comparison(`Times recommended · ${scene.denominator} answers`, { name: scene.prospectName, num: scene.prospectRecommendations, sub: `of ${scene.denominator}` }, { name: scene.competitorName, num: scene.competitorRecommendations, sub: scene.recommendationMultiple ? `${scene.recommendationMultiple}` : `of ${scene.denominator}` }, "Same questions, same test, counted the same way.");
    case "MismatchInterpretationScene":
      return frame(`<div class="eyebrow">The gap</div><div class="body">${fitted(scene.summary, FIT.body)}</div><div class="rule"></div><div class="body" style="color:${SCENE_COLORS.muted}">${fitted(scene.connective, FIT.quote)}</div>`);
    case "ExampleEvidenceScene":
      return frame(`<div class="eyebrow">One of the questions</div><div class="body">${fitted(scene.question, FIT.body)}</div><div class="quote">${fitted(scene.quote, FIT.quote)}</div>`, { footer: "Captured answer, quoted as recorded. The full set is in your report." });
    case "FirstActionScene":
      return frame(`<div class="eyebrow">The first thing I would look at</div><div class="body">${fitted(scene.title, FIT.body)}</div><div class="rule"></div><div class="body" style="color:${SCENE_COLORS.muted}">${fitted(scene.body, FIT.quote)}</div>`);
    case "ClosingScene":
      return frame(`<div class="eyebrow">Everything is in your private report</div><div class="h1">${fitted(`Thanks, ${scene.prospectFirstName}.`, FIT.title)}</div><div class="rule"></div><div class="body" style="color:${SCENE_COLORS.muted};font-size:40px">If anything jumps out, just reply to the email.</div>`);
  }
}
