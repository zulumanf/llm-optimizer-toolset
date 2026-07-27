/** Render-time formatting only — storage is always timestamptz UTC (docs/11). */
export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
