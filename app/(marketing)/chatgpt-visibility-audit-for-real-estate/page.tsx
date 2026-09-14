import type { Metadata } from "next";
import { JsonLd } from "@/components/marketing/json-ld";
import { CheckVisibilityCta } from "@/components/marketing/ui";
import { ArticleSection, ArticleShell, Definitions, InstrumentNote } from "@/components/marketing/research";
import { breadcrumbLd, marketingMetadata } from "@/lib/marketing/seo";

const PATH = "/chatgpt-visibility-audit-for-real-estate";
export const metadata: Metadata = marketingMetadata(PATH);

export default function AuditGuidePage() {
  return (
    <ArticleShell
      path={PATH}
      eyebrow="Guide"
      lede="A visibility audit answers one question with counts: when buyers and sellers ask an AI assistant who to hire in your market, how often are you named, how often are competitors named, and what did the assistant cite? This page describes exactly what the audit measures, what you receive, and what it cannot tell you."
      meta={[
        { label: "Instruments", value: "the OpenAI model (gpt-5.4-mini, web search, API); Perplexity (sonar, API)" },
        { label: "Sample", value: "16–64 frozen questions × 4 repetitions per assistant" },
      ]}
      related={["/methodology", "/research/chatgpt-real-estate-visibility-benchmark", "/citation-intelligence", "/faq"]}
    >
      <JsonLd data={breadcrumbLd(PATH)} />
      <InstrumentNote />
      <ArticleSection title="What is measured">
        <Definitions
          items={[
            { term: "Named / mentioned", definition: "Whether your team, its aliases and its lead agent appear in each answer at all." },
            { term: "Recommended", definition: "Whether the answer says to use or contact you, one credit per answer, out of the valid answers." },
            { term: "Competitors", definition: "Every other entity recommended in the same answers, counted the same way." },
            { term: "Cited sources", definition: "The domains and URLs the assistant attached to its answers, and whether you appear on them." },
            { term: "Production context", definition: "Where a licensed RealTrends verified record exists, your recommendation count placed next to it (same year, same measure), kept separate." },
          ]}
        />
      </ArticleSection>
      <ArticleSection title="What you receive">
        <p>A private report: the counts with denominators and capture date, the question list, the competitor table, the cited-source table with link health, the entity checks that were run, the confidence label on each finding (observed fact, supported finding, working hypothesis, unknown), and the complete set of captured answers as an appendix so an absence can be verified rather than trusted.</p>
      </ArticleSection>
      <ArticleSection title="What it cannot show">
        <p>Why an assistant answered as it did; what a specific buyer saw in their own ChatGPT session; how many buyers ask these questions; whether an absence cost a listing or a recommendation produced one. A single run is a snapshot; movement needs a second run on the same frozen questions with the same instruments.</p>
      </ArticleSection>
      <ArticleSection title="How to request one">
        <p>Use the form on the homepage. A person reads every request before any measurement, and conflict checks run first: we do not audit direct competitors in one market for the same engagement.</p>
        <CheckVisibilityCta />
      </ArticleSection>
    </ArticleShell>
  );
}
