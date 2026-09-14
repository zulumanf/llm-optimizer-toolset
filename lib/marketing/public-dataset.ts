/** Serves the committed public dataset release (data/public) as downloads.
 * CSV is derived from the JSON at request time so the two never disagree. */
import release from "@/data/public/real-estate-ai-visibility-benchmark.json";

export const PUBLIC_DATASET_VERSION = (release as { meta: { version: string } }).meta.version;

export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0] as object);
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

type Release = { meta: Record<string, unknown>; benchmarks: Record<string, unknown>[]; domains: Record<string, unknown>[]; entities: Record<string, unknown>[] };

export function publicDatasetFile(file: string): { body: string; contentType: string } | null {
  const r = release as Release;
  switch (file) {
    case "real-estate-ai-visibility-benchmark.json":
      return { body: JSON.stringify(r), contentType: "application/json; charset=utf-8" };
    case "real-estate-ai-visibility-benchmark.csv":
      return { body: toCsv(r.benchmarks), contentType: "text/csv; charset=utf-8" };
    case "real-estate-ai-visibility-benchmark-domains.csv":
      return { body: toCsv(r.domains), contentType: "text/csv; charset=utf-8" };
    case "real-estate-ai-visibility-benchmark-entities.csv":
      return { body: toCsv(r.entities), contentType: "text/csv; charset=utf-8" };
    default:
      return null;
  }
}
