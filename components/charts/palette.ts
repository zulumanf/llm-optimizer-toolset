/**
 * Chart palette — the dataviz reference categorical palette, dark-mode steps
 * (the app renders charts on the dark card surface), validated 2026-07-27 by
 * scripts/validate_palette.js against surface #1c1c1c (slots 1–5 pass all
 * adjacent-pair gates). Slot order is the CVD-safety mechanism — never cycle
 * or reorder. Color follows the entity: each provider owns its slot
 * permanently, regardless of which providers appear in a given chart.
 */
export const SERIES_SLOTS = [
  "#3987e5", // 1 blue
  "#d95926", // 2 orange
  "#199e70", // 3 aqua
  "#c98500", // 4 yellow
  "#d55181", // 5 magenta
] as const;

/** Fixed provider→slot assignment (registry order). */
export const PROVIDER_COLORS: Record<string, string> = {
  anthropic: SERIES_SLOTS[0],
  openai: SERIES_SLOTS[1],
  google: SERIES_SLOTS[2],
  perplexity: SERIES_SLOTS[3],
  mock: SERIES_SLOTS[4],
};

/** The cross-provider aggregate is chrome, not a series: dashed neutral ink. */
export const AGGREGATE_COLOR = "#c3c2b7";

export const CHART_INK = {
  muted: "#898781",
  grid: "#2c2c2a",
  axis: "#383835",
} as const;
