/**
 * Public methodology page (spec 061, brief §51). Unusually transparent on
 * purpose: the transparency is part of the product. Everything stated here
 * describes how the measurement platform actually works — versioned prompt
 * sets, immutable capture, repeat sampling, confidence classification. If
 * practice changes, this page changes with it.
 */
import type { Metadata } from "next";
import { Newsreader } from "next/font/google";
import { CheckVisibilityCta, Eyebrow } from "@/components/marketing/ui";

const serif = Newsreader({ subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "How We Measure AI Visibility | Recommended First",
  description:
    "The measurement methodology behind our AI visibility audits: prompt universe construction, repeat testing, recommendation share, citation and entity analysis, confidence classification, and known limitations.",
};

const SECTIONS: { title: string; paragraphs: string[] }[] = [
  {
    title: "What we measure",
    paragraphs: [
      "We measure how AI assistants represent and recommend real estate agents and teams: whether a brand is mentioned, whether it is recommended, in what position, alongside which competitors, and supported by which citations. We measure outputs, not internals. We have no access to any model's ranking systems and never claim otherwise.",
    ],
  },
  {
    title: "Prompt universe construction",
    paragraphs: [
      "Each engagement starts from a structured set of questions real buyers and sellers ask: seller-intent, buyer-intent, neighborhood-specific, property-segment-specific, and comparison questions. The set is written for the client's actual market, then locked and versioned before testing begins. Re-testing later uses the same versioned set, so changes in results reflect changes in the answers, not changes in the questions.",
    ],
  },
  {
    title: "Model selection",
    paragraphs: [
      "Coverage targets the leading AI answer and recommendation platforms. The exact platforms for an engagement are chosen for relevance to the client's market and technical feasibility, and are stated in the measurement plan. We do not list platforms we cannot operationally test.",
    ],
  },
  {
    title: "Testing procedure",
    paragraphs: [
      "Every prompt is asked multiple separate times per platform. AI answers vary between asks, so a single response is an anecdote; the pattern across repeated responses is the finding. Each raw response is captured verbatim and stored immutably before any parsing or scoring. Raw responses are never edited, and re-running a measurement never overwrites a previous one.",
    ],
  },
  {
    title: "AI Recommendation Share",
    paragraphs: [
      "Our primary KPI: the percentage of relevant tested responses in which the brand appears as a recommendation. We distinguish being mentioned (named at all) from being recommended (the answer says to use them). Counts are reported with their sample sizes, because 3 of 40 is a different claim than 30 of 400.",
    ],
  },
  {
    title: "Citation and source analysis",
    paragraphs: [
      "Where platforms expose citations, we record which sources the answers drew on and how often. This shows which surfaces the answers lean on in a given market, and where a client is absent from them. Citation presence is evidence for diagnosis, not proof of causation, and we label it accordingly.",
    ],
  },
  {
    title: "Entity analysis",
    paragraphs: [
      "We examine how consistently the brand is represented across the sources AI systems can access: names, roles, markets, specializations, and the agreement between them. Fragmented or contradictory entity information is a common, fixable finding.",
    ],
  },
  {
    title: "Competitive benchmarking",
    paragraphs: [
      "Every measurement includes the competitors named in the same answers. Visibility is relative: 20% recommendation share means one thing when the leader holds 25%, another when the leader holds 70%.",
    ],
  },
  {
    title: "Diagnostic framework",
    paragraphs: [
      "The AI Visibility Index summarizes multiple observable dimensions (recommendation presence, prompt coverage, source coverage, entity consistency, competitive position) into one diagnostic composite. It exists to make progress trackable, and it is versioned: when the scoring method changes, new scores are computed forward and old scores are never rewritten. It is not a proprietary ranking factor and does not represent knowledge of any model's internals.",
    ],
  },
  {
    title: "Intervention tracking",
    paragraphs: [
      "Interventions are documented as discrete, dated actions with their rationale and the evidence that motivated them. This is what makes verification meaningful: a retest can be compared against a record of exactly what changed and when.",
    ],
  },
  {
    title: "Retesting",
    paragraphs: [
      "Follow-up measurement reruns the same versioned prompt set on the same platforms, then compares against the baseline. Differences are reported with sample sizes and confidence, including the differences that went the wrong way. A failed measurement is recorded as failed, never filled in.",
    ],
  },
  {
    title: "Confidence classification",
    paragraphs: [
      "Every conclusion carries one of four labels. Observed fact: directly captured. Supported finding: backed by multiple pieces of evidence. Working hypothesis: a plausible explanation requiring further testing. Unknown: the evidence is insufficient, and we say so. We do not report false precision; a confidence percentage appears only when an actual statistical model produced it.",
    ],
  },
  {
    title: "Known limitations",
    paragraphs: [
      "AI outputs are probabilistic and change over time, including for reasons unrelated to anything we do. Correlation between a signal and an outcome is not causation. Platform citation data is partial. Sample sizes bound what can be claimed. These limitations appear in every report, next to the findings they qualify, because a methodology that hides its limits isn't one.",
    ],
  },
  {
    title: "Methodology versioning",
    paragraphs: [
      "Prompt sets, scoring methods, and parsers are versioned. Historical measurements are never modified; new versions apply forward. When this page's methodology changes, the change is deliberate and dated.",
    ],
  },
];

export default function MethodologyPage() {
  return (
    <div className="mx-auto max-w-3xl px-6 py-16">
      <Eyebrow>Methodology</Eyebrow>
      <h1
        className={`${serif.className} mt-3 text-balance text-2xl font-medium tracking-tight sm:text-4xl`}
      >
        How we measure AI visibility.
      </h1>
      <p className="mt-4 max-w-[65ch] text-sm leading-relaxed text-muted-foreground">
        Our measurement methodology, published in full. It is designed around
        the realities of AI systems: outputs vary, models change, and
        correlation is not causation. Transparency about that is not a
        weakness of the product; it is the product.
      </p>

      <div className="mt-12 space-y-10">
        {SECTIONS.map((section, i) => (
          <section key={section.title}>
            <h2 className="text-lg font-medium">
              <span className="text-muted-foreground tabular-nums">
                {String(i + 1).padStart(2, "0")}.
              </span>{" "}
              {section.title}
            </h2>
            {section.paragraphs.map((p) => (
              <p
                key={p.slice(0, 32)}
                className="mt-2 max-w-[65ch] text-sm leading-relaxed text-muted-foreground"
              >
                {p}
              </p>
            ))}
          </section>
        ))}
      </div>

      <div className="mt-14 border-t pt-8">
        <p className={`${serif.className} max-w-[50ch] text-balance text-lg`}>
          Before you optimize AI visibility, measure it.
        </p>
        <div className="mt-4">
          <CheckVisibilityCta />
        </div>
      </div>
    </div>
  );
}
