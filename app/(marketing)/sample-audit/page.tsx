/**
 * Sample audit (spec 061, brief §52). A report viewer, not a brochure: the
 * prospect should be able to judge the quality of the work before talking to
 * anyone. Every figure on this page is a hand-written fixture for an example
 * market, labeled illustrative at the top, in every section, and at the foot.
 * Real audits are produced per prospect and delivered privately.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Newsreader } from "next/font/google";
import {
  ShareBar,
  DataPoint,
  ConfidenceBadge,
  IllustrativeLabel,
  CheckVisibilityCta,
  Eyebrow,
} from "@/components/marketing/ui";

const serif = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Sample AI Visibility Audit | Recommended First",
  description:
    "An example of our AI visibility audit: recommendation share, prompt-level results, competitor analysis, source coverage, and prioritized actions, with every conclusion classified by confidence.",
};

const CONTENTS = [
  ["#summary", "Executive summary"],
  ["#visibility", "AI visibility"],
  ["#prompts", "Prompt performance"],
  ["#competitors", "Competitors"],
  ["#sources", "Sources"],
  ["#actions", "Prioritized actions"],
  ["#method", "Methodology"],
] as const;

const PROMPT_RESULTS = [
  {
    prompt: "Who are the best luxury real estate agents in Manhattan?",
    recommended: "Competitor A, Competitor B",
    you: "Not mentioned",
  },
  {
    prompt: "Who should I use to sell my Tribeca apartment?",
    recommended: "Competitor A, Competitor C",
    you: "Not mentioned",
  },
  {
    prompt: "Top listing agents for $5M+ properties in NYC",
    recommended: "Competitor A, Competitor B, Your team",
    you: "Recommended (position 3)",
  },
  {
    prompt: "Best agent for luxury sellers in SoHo",
    recommended: "Competitor B",
    you: "Mentioned, not recommended",
  },
];

const ACTIONS = [
  {
    title: "Consolidate entity information across the top profile surfaces",
    why: "Entity signals for the team disagree on name, markets served, and specialization across the sources answers cite most.",
    classification: "Supported finding",
    confidence: "high" as const,
    effort: "Low",
  },
  {
    title: "Build seller-intent content for the three uncovered prompt clusters",
    why: "The team has no accessible content answering the seller-side questions where competitors are recommended most often.",
    classification: "Supported finding",
    confidence: "high" as const,
    effort: "Medium",
  },
  {
    title: "Pursue citation opportunities on the two dominant source domains",
    why: "The two domains cited most in this market's answers reference three competitors and not the team.",
    classification: "Working hypothesis",
    confidence: "medium" as const,
    effort: "Medium",
  },
  {
    title: "Strengthen Tribeca topical association",
    why: "The team's strongest real-world segment shows the weakest category association in tested answers.",
    classification: "Working hypothesis",
    confidence: "medium" as const,
    effort: "High",
  },
];

function SectionBlock({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-24 border-t py-10">
      <h2 className="text-lg font-medium">{title}</h2>
      {children}
    </section>
  );
}

export default function SampleAuditPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <Eyebrow>Sample audit</Eyebrow>
      <h1
        className={`${serif.className} mt-3 text-balance text-2xl font-medium tracking-tight sm:text-4xl`}
      >
        AI visibility audit, example market.
      </h1>
      <div className="mt-4 rounded-md border border-warning/60 bg-muted/40 p-4">
        <IllustrativeLabel>Sample report. All data illustrative, no client data.</IllustrativeLabel>
        <p className="mt-1.5 max-w-[65ch] text-sm text-muted-foreground">
          This document shows the structure, depth, and honesty of a real audit
          using hand-written example data for a fictional team (&ldquo;Your
          team&rdquo;) in
          Manhattan luxury real estate. A real audit is measured, not written.
        </p>
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">Market</dt>
          <dd className="mt-0.5 font-medium">Manhattan luxury (example)</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Window</dt>
          <dd className="mt-0.5 font-medium">Illustrative</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Prompts tested</dt>
          <dd className="mt-0.5 font-medium tabular-nums">24</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Responses captured</dt>
          <dd className="mt-0.5 font-medium tabular-nums">192</dd>
        </div>
      </dl>

      <nav aria-label="Report contents" className="mt-8">
        <ul className="flex flex-wrap gap-x-4 gap-y-2">
          {CONTENTS.map(([href, label]) => (
            <li key={href}>
              <a
                href={href}
                className="text-sm text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                {label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <div className="mt-10">
        <SectionBlock id="summary" title="Executive summary">
          <p className="mt-3 max-w-[65ch] text-sm leading-relaxed">
            In 192 captured answers to 24 buyer and seller questions, the team
            appeared as a recommendation in 15 (8%). Competitor A appeared in
            119 (62%). The team&apos;s real-world position (top-ranked producer in
            this illustration) is not reflected in AI recommendations: the gap
            is measurable, and the evidence below points to three addressable
            causes.
          </p>
          <div className="mt-5 grid grid-cols-2 gap-6 sm:grid-cols-3">
            <DataPoint label="AI recommendation share" value="8%" sub="15 / 192 answers" negative />
            <DataPoint label="Most-recommended rival" value="62%" sub="Competitor A" />
            <DataPoint label="Prompt coverage" value="6 / 24" sub="Prompts where you appear" negative />
          </div>
          <div className="mt-4">
            <IllustrativeLabel />
          </div>
        </SectionBlock>

        <SectionBlock id="visibility" title="AI visibility">
          <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
            Share of tested answers in which each team appears as a
            recommendation, across all platforms and prompts.
          </p>
          <div className="mt-4">
            <ShareBar name="Competitor A" pct={62} />
            <ShareBar name="Competitor B" pct={47} />
            <ShareBar name="Competitor C" pct={31} />
            <ShareBar name="Your team" pct={8} isSubject />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            One answer can recommend several teams, so shares don&apos;t sum to
            100%. Counted from captured answers; in a real audit every answer is
            available verbatim in the evidence appendix.
          </p>
        </SectionBlock>

        <SectionBlock id="prompts" title="Prompt performance">
          <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
            Results per question, excerpted. A real audit covers the full prompt
            universe with per-platform detail.
          </p>
          <ul className="mt-4 space-y-4">
            {PROMPT_RESULTS.map((row) => (
              <li key={row.prompt} className="rounded-md border p-4">
                <p className={`${serif.className} text-lg italic leading-snug`}>
                  &ldquo;{row.prompt}&rdquo;
                </p>
                <dl className="mt-2 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">Recommended</dt>
                    <dd className="mt-0.5">{row.recommended}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Your team</dt>
                    <dd
                      className={`mt-0.5 ${
                        row.you.startsWith("Not") ? "text-destructive" : ""
                      }`}
                    >
                      {row.you}
                    </dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        </SectionBlock>

        <SectionBlock id="competitors" title="Competitors">
          <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
            Why Competitor A keeps being recommended, on the evidence available:
            broader third-party coverage (12 relevant sources vs 3), consistent
            entity information across the surfaces answers cite, and presence in
            the comparison content the answers draw on. These indicators support
            diagnosis; they are not claims of algorithmic causation.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <span className="text-sm">Classification:</span>
            <span className="text-sm font-medium">Supported finding</span>
            <ConfidenceBadge level="high" />
          </div>
        </SectionBlock>

        <SectionBlock id="sources" title="Sources">
          <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
            The source domains cited most across the captured answers, and
            whether they reference the team. In a real audit each source entry
            links out and carries its capture date.
          </p>
          <ul className="mt-4 space-y-3">
            {[
              {
                domain: "Market editorial site (example)",
                cites: 31,
                you: "missing",
              },
              { domain: "Agent directory (example)", cites: 24, you: "partial" },
              { domain: "Rankings publisher (example)", cites: 17, you: "missing" },
            ].map((s) => (
              <li key={s.domain} className="rounded-md border p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-medium">{s.domain}</p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    Cited {s.cites}× in captured answers
                  </p>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {s.you === "missing"
                    ? "References competitors; does not reference the team."
                    : "References the team with outdated entity information."}
                </p>
              </li>
            ))}
          </ul>
        </SectionBlock>

        <SectionBlock id="actions" title="Prioritized actions">
          <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
            Ordered by evidence, expected impact, feasibility, and confidence.
            Each action carries its classification, so you can see which
            recommendations rest on observed facts and which on hypotheses.
          </p>
          <ol className="mt-4 space-y-4">
            {ACTIONS.map((action, i) => (
              <li key={action.title} className="rounded-md border p-4">
                <p className="text-sm font-medium">
                  {i + 1}. {action.title}
                </p>
                <p className="mt-1 max-w-[65ch] text-sm text-muted-foreground">
                  {action.why}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
                  <span>{action.classification}</span>
                  <ConfidenceBadge level={action.confidence} />
                  <span>Effort: {action.effort}</span>
                </div>
              </li>
            ))}
          </ol>
        </SectionBlock>

        <SectionBlock id="method" title="Methodology">
          <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
            Every audit uses the published methodology: a locked, versioned
            prompt set; repeated asks per platform; immutable capture of every
            raw answer before scoring; counted (never estimated) shares; and
            four-level confidence classification.{" "}
            <Link
              href="/methodology"
              className="underline underline-offset-2 transition-colors hover:text-foreground"
            >
              Read the full methodology
            </Link>
            .
          </p>
        </SectionBlock>
      </div>

      <div className="border-t pt-8">
        <IllustrativeLabel>End of sample. All figures illustrative.</IllustrativeLabel>
        <p className={`${serif.className} mt-4 max-w-[50ch] text-balance text-lg`}>
          A real audit answers one question: do you have a visibility problem
          worth solving?
        </p>
        <div className="mt-4">
          <CheckVisibilityCta />
        </div>
      </div>
    </div>
  );
}
