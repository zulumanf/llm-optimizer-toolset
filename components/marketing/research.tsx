/**
 * Shared frame for the public source-of-truth pages (research reports,
 * citation intelligence, FAQ, about): one H1, a dated metadata line,
 * answer-first sections, crawlable HTML tables, related links. Server-only,
 * no client interaction required to read anything.
 */
import Link from "next/link";
import { Newsreader } from "next/font/google";
import { Eyebrow } from "@/components/marketing/ui";
import { MARKETING_PAGES, marketingPage } from "@/lib/marketing/constants";
import { PUBLIC_DATASET_VERSION } from "@/lib/marketing/public-dataset";

const serif = Newsreader({ subsets: ["latin"], weight: ["400", "500"] });

export function ArticleShell({
  path,
  eyebrow,
  lede,
  meta,
  children,
  related,
}: {
  path: string;
  eyebrow: string;
  lede: string;
  /** Dated facts shown under the title: benchmark window, sample size, instruments. */
  meta: readonly { label: string; value: string }[];
  children: React.ReactNode;
  related: readonly string[];
}) {
  const page = marketingPage(path);
  return (
    <article className="mx-auto max-w-3xl px-6 py-16">
      <Eyebrow>{eyebrow}</Eyebrow>
      <h1 className={`${serif.className} mt-3 text-balance text-2xl font-medium tracking-tight sm:text-4xl`}>
        {page.title}
      </h1>
      <p className="mt-4 max-w-[65ch] text-sm leading-relaxed text-muted-foreground">{lede}</p>
      <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-2 border-y py-4 text-xs sm:grid-cols-2">
        <div className="flex gap-2">
          <dt className="text-muted-foreground">Page updated</dt>
          <dd>
            <time dateTime={page.updated}>{page.updated}</time>
          </dd>
        </div>
        {meta.map((m) => (
          <div key={m.label} className="flex gap-2">
            <dt className="text-muted-foreground">{m.label}</dt>
            <dd>{m.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-10 space-y-10">{children}</div>
      <RelatedLinks paths={related} />
    </article>
  );
}

export function ArticleSection({ title, children, id }: { title: string; children: React.ReactNode; id?: string }) {
  return (
    <section id={id}>
      <h2 className="text-lg font-medium">{title}</h2>
      <div className="mt-2 space-y-3 text-sm leading-relaxed text-muted-foreground [&_p]:max-w-[65ch]">
        {children}
      </div>
    </section>
  );
}

export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: readonly string[];
  rows: readonly (readonly (string | number)[])[];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[28rem] border-collapse text-sm">
        <caption className="mb-2 text-left text-xs text-muted-foreground">{caption}</caption>
        <thead>
          <tr className="border-b text-left">
            {columns.map((c, i) => (
              <th key={c} scope="col" className={`py-2 pr-4 font-medium ${i > 0 ? "text-right" : ""}`}>
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r[0])} className="border-b last:border-0">
              {r.map((cell, i) => (
                <td key={`${r[0]}-${i}`} className={`py-2 pr-4 ${i > 0 ? "text-right tabular-nums" : "text-foreground"}`}>
                  {typeof cell === "number" ? cell.toLocaleString("en-US") : cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Definitions({ items }: { items: readonly { term: string; definition: string }[] }) {
  return (
    <dl className="space-y-3">
      {items.map((d) => (
        <div key={d.term}>
          <dt className="font-medium text-foreground">{d.term}</dt>
          <dd className="max-w-[65ch]">{d.definition}</dd>
        </div>
      ))}
    </dl>
  );
}

export function RelatedLinks({ paths }: { paths: readonly string[] }) {
  const pages = MARKETING_PAGES.filter((p) => paths.includes(p.path));
  return (
    <nav aria-label="Related pages" className="mt-14 border-t pt-6">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">Related</p>
      <ul className="mt-2 space-y-1 text-sm">
        {pages.map((p) => (
          <li key={p.path}>
            <Link href={p.path} className="underline underline-offset-4 hover:text-muted-foreground">
              {p.title}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The instrument sentence every benchmark page must carry, verbatim. */
export const INSTRUMENT_NOTE =
  "This benchmark measures the OpenAI web-search API instrument and should not be interpreted as a direct measurement of every consumer ChatGPT session.";

export function InstrumentNote({ perplexity = true }: { perplexity?: boolean }) {
  return (
    <p className="rounded-md border px-4 py-3 text-sm leading-relaxed text-muted-foreground">
      {INSTRUMENT_NOTE}
      {perplexity ? " Perplexity figures come from the Perplexity API (sonar) under the same rules." : ""}
    </p>
  );
}

export function CiteThis({ title, market, captureDate, version, url }: { title: string; market: string; captureDate: string; version: string; url: string }) {
  return (
    <ArticleSection title="How to cite this research">
      <p>Quote the count with its denominator, the capture date and the instrument. Suggested format:</p>
      <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 text-xs text-foreground">
        {`Recommended First. ${title}: ${market}, ${captureDate}, ${version}. ${url}`}
      </pre>
    </ArticleSection>
  );
}

export function UpdateHistory({ items }: { items: readonly { date: string; note: string }[] }) {
  return (
    <ArticleSection title="Update history">
      <ul className="space-y-1">
        {items.map((i) => (
          <li key={`${i.date}-${i.note.slice(0, 24)}`}>
            <time dateTime={i.date} className="text-foreground">{i.date}</time> — {i.note}
          </li>
        ))}
      </ul>
    </ArticleSection>
  );
}

export function SourceLinks({ items }: { items: readonly { label: string; href: string; note?: string }[] }) {
  return (
    <ArticleSection title="Source links">
      <ul className="space-y-1">
        {items.map((i) => (
          <li key={i.href}>
            <a href={i.href} className="underline underline-offset-4 hover:text-foreground" rel={i.href.startsWith("http") ? "nofollow noopener" : undefined}>
              {i.label}
            </a>
            {i.note ? ` — ${i.note}` : ""}
          </li>
        ))}
      </ul>
    </ArticleSection>
  );
}

export const PUBLIC_DATA_FILES = [
  { file: "real-estate-ai-visibility-benchmark.csv", label: "Benchmark summary (CSV, one row per benchmark × assistant)" },
  { file: "real-estate-ai-visibility-benchmark-domains.csv", label: "Cited domains per benchmark (CSV)" },
  { file: "real-estate-ai-visibility-benchmark-entities.csv", label: "Anonymized entity counts per benchmark (CSV)" },
  { file: "real-estate-ai-visibility-benchmark.json", label: "Full release (JSON)" },
] as const;

export function DownloadLinks() {
  return (
    <ArticleSection title="Downloadable tables">
      <p>Version {PUBLIC_DATASET_VERSION} of the public dataset (corpus through 2026-09-07). Only verified classifications are counted; pairs awaiting manual review are excluded and disclosed per row as blocked_pairs. No answer text, prompt text, entity names, contacts or licensed production data are included; the data dictionary is in the repository release notes.</p>
      <ul className="space-y-1">
        {PUBLIC_DATA_FILES.map((f) => (
          <li key={f.file}>
            <a href={`/research-data/${f.file}`} className="underline underline-offset-4 hover:text-foreground">{f.label}</a>
          </li>
        ))}
      </ul>
    </ArticleSection>
  );
}
