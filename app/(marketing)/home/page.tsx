/**
 * Marketing homepage (spec 061). The page is an unfolding investigation:
 * question → AI response → who gets recommended → the gap → why → what can
 * change → how we verify → request your own analysis. Proof before pitch;
 * every demo figure labeled illustrative at the point of display.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Newsreader } from "next/font/google";
import { AuditDemo } from "@/components/marketing/audit-demo";
import { RequestForm } from "@/components/marketing/request-form";
import {
  Section,
  SectionHeading,
  Eyebrow,
  IllustrativeLabel,
  DataPoint,
  SignalRow,
  CheckVisibilityCta,
  SampleAuditCta,
  ConfidenceBadge,
} from "@/components/marketing/ui";

const serif = Newsreader({
  subsets: ["latin"],
  weight: ["400", "500"],
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "AI Recommendation Intelligence for Real Estate | Recommended First",
  description:
    "We measure how ChatGPT, Gemini, Claude and Perplexity represent and recommend real estate agents and teams, diagnose competitive visibility gaps, and engineer evidence-backed improvements.",
};

const RECOMMENDATION_MOMENTS = [
  "Who are the best luxury real estate agents in Tribeca?",
  "Who should I use to sell a $5M condo in Manhattan?",
  "Who are the top listing agents in Jersey City?",
  "Who specializes in waterfront property in Miami?",
  "Which agent has the strongest track record selling luxury condos in SoHo?",
  "Who are the best alternatives to the biggest team in my market?",
];

const INTERVENTION_AREAS = [
  {
    title: "Entity clarity",
    body: "Helping platforms consistently understand who the team is, what it does, and where it operates.",
  },
  {
    title: "Authority signals",
    body: "Strengthening credible, verifiable signals that support expertise and market position.",
  },
  {
    title: "Third-party coverage",
    body: "Identifying gaps in independent sources relevant to recommendation questions.",
  },
  {
    title: "Content architecture",
    body: "Creating information that directly answers high-intent buyer and seller questions.",
  },
  {
    title: "Topical association",
    body: "Tightening the connection between the brand and its markets, specialties, and property categories.",
  },
  {
    title: "Structured information",
    body: "Making important facts clear, consistent, and machine-accessible.",
  },
  {
    title: "Technical accessibility",
    body: "Ensuring the information that matters can actually be found and interpreted.",
  },
  {
    title: "Citation opportunities",
    body: "Finding credible contexts in which brand information can be corroborated.",
  },
  {
    title: "Competitive coverage",
    body: "Closing the specific information gaps where competitors currently have stronger support.",
  },
];

const FAQ: { q: string; a: string }[] = [
  {
    q: "Can you guarantee that ChatGPT will recommend us?",
    a: "No. AI outputs are probabilistic, models change frequently, and we do not control their recommendation systems. We improve measurable inputs and representation, then track whether observable outcomes change.",
  },
  {
    q: "How is this different from SEO?",
    a: "SEO focuses on the discoverability and ranking of webpages. AI visibility examines whether AI systems understand and surface the brand itself across recommendation-oriented questions. The disciplines overlap, but the measurement problem is different.",
  },
  {
    q: "How do you know what influences an AI answer?",
    a: "We distinguish between what we can directly observe and what we infer. We capture model outputs, citations, sources, competitive patterns, and entity information. When causation cannot be established, we label conclusions as hypotheses rather than facts.",
  },
  {
    q: "What platforms do you measure?",
    a: "Our framework evaluates leading AI answer and recommendation platforms. Coverage for a given engagement is determined by relevance to your market and technical feasibility, and is stated in the measurement plan before testing begins.",
  },
  {
    q: "How long does this take?",
    a: "Measurement can begin immediately after onboarding. Underlying signals and recommendation outcomes move on different timelines, so we track leading indicators as well as recommendation results rather than promising a fixed deadline.",
  },
  {
    q: "Is this just content creation?",
    a: "No. Content may be one intervention, but the system also covers entity clarity, third-party authority, citations, structured information, technical accessibility, and topical associations, depending on what the diagnosis actually shows.",
  },
  {
    q: "Do we need to replace our SEO agency?",
    a: "Usually not. Strong SEO, PR, and content work supports AI visibility. Our job is to identify the additional recommendation-specific gaps and coordinate with existing partners where useful.",
  },
  {
    q: "What access do you need?",
    a: "It depends on the engagement. We minimize required permissions and define exactly what is needed during onboarding.",
  },
  {
    q: "What happens if our AI visibility is already strong?",
    a: "Then the audit should show that. We would rather tell you there is no meaningful problem than manufacture one.",
  },
];

export default function MarketingHomePage() {
  return (
    <div>
      {/* 02 — hero */}
      <Section>
        <div className="max-w-3xl">
          <Eyebrow>AI recommendation intelligence for real estate</Eyebrow>
          <h1
            className={`${serif.className} mt-3 text-balance text-2xl font-medium tracking-tight sm:text-4xl`}
          >
            Your competitors are being recommended by AI. Are you?
          </h1>
          <p className="mt-4 max-w-[65ch] text-sm leading-relaxed text-muted-foreground sm:text-lg sm:leading-relaxed">
            We measure how ChatGPT, Gemini, Claude, Perplexity and other AI
            systems represent and recommend real estate agents and teams,
            identify why competitors are winning, and engineer the signals that
            can improve your visibility.
          </p>
          <p className="mt-3 max-w-[65ch] text-sm text-muted-foreground">
            Built for market-leading teams whose real-world reputation isn&apos;t
            yet reflected in AI recommendations.
          </p>
          <div className="mt-6 flex flex-col gap-3 sm:flex-row">
            <CheckVisibilityCta />
            <SampleAuditCta />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Evidence-first analysis. No ranking guarantees. No black-box claims.
          </p>
        </div>

        {/* 03 — the audit is the product */}
        <div className="mt-12">
          <h2 className={`${serif.className} text-2xl font-medium tracking-tight`}>
            See the gap.
          </h2>
          <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">
            AI visibility can be measured. The first step is comparing who leads
            in the real world with who appears in AI-generated recommendations.
          </p>
          <div className="mt-5">
            <AuditDemo />
          </div>
        </div>
      </Section>

      {/* 04 — the visibility gap */}
      <Section bordered>
        <SectionHeading
          eyebrow="The visibility gap"
          title="Real-world authority does not automatically translate into AI visibility."
          lede="AI systems don't evaluate production volume alone. Their answers reflect a broader network of information: sources, entities, authority signals, topical associations, and accessible content."
          serifClass={serif.className}
        />
        <div className="mt-8 grid gap-6 md:grid-cols-[1fr_auto_1fr] md:items-start">
          <div className="rounded-lg border p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Real world
            </p>
            <ul className="mt-3">
              <SignalRow state="present">Top-performing team</SignalRow>
              <SignalRow state="present">Significant transaction volume</SignalRow>
              <SignalRow state="present">Strong client reputation</SignalRow>
              <SignalRow state="present">Years of market experience</SignalRow>
              <SignalRow state="present">Deep neighborhood expertise</SignalRow>
            </ul>
          </div>
          <p className="hidden self-center text-xs font-medium uppercase tracking-wide text-muted-foreground md:block">
            → Visibility gap
          </p>
          <div className="rounded-lg border p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              AI representation
            </p>
            <ul className="mt-3">
              <SignalRow state="missing">Rarely recommended</SignalRow>
              <SignalRow state="missing">Competitor mentioned instead</SignalRow>
              <SignalRow state="partial">Weak category association</SignalRow>
              <SignalRow state="missing">Limited supporting citations</SignalRow>
              <SignalRow state="partial">Fragmented brand and entity signals</SignalRow>
            </ul>
          </div>
        </div>
        <p className="mt-6 max-w-[65ch] text-sm text-muted-foreground">
          Our job is to measure that gap, determine what evidence may explain it,
          and identify what can realistically be improved.
        </p>
      </Section>

      {/* 05 — recommendation share + visibility index */}
      <Section bordered>
        <SectionHeading
          title="A vague question, made measurable."
          lede="Two instruments turn &ldquo;how visible are we in AI?&rdquo; into numbers that can be tracked over time and compared against competitors."
          serifClass={serif.className}
        />
        <div className="mt-8 grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border p-6">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Primary KPI
            </p>
            <h3 className="mt-1 text-lg font-medium">AI Recommendation Share</h3>
            <p className="mt-1.5 max-w-[55ch] text-sm text-muted-foreground">
              The percentage of relevant tested recommendation responses in which
              your brand appears.
            </p>
            <div className="mt-5 border-t pt-5">
              <p className="text-2xl font-semibold tracking-tight tabular-nums">18%</p>
              <p className="mt-1 text-sm text-muted-foreground tabular-nums">
                34 / 190 qualifying responses
              </p>
              <div className="mt-3">
                <IllustrativeLabel />
              </div>
            </div>
          </div>
          <div className="rounded-lg border p-6">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Diagnostic framework
            </p>
            <h3 className="mt-1 text-lg font-medium">AI Visibility Index</h3>
            <p className="mt-1.5 max-w-[55ch] text-sm text-muted-foreground">
              A diagnostic composite summarizing multiple observable dimensions
              of AI visibility. It is not a proprietary ranking factor and is
              never presented as one.
            </p>
            <div className="mt-5 border-t pt-5">
              <p className="text-2xl font-semibold tracking-tight tabular-nums">
                24 <span className="text-sm font-normal text-muted-foreground">/ 100</span>
              </p>
              <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                {[
                  ["Recommendation presence", "18"],
                  ["Prompt coverage", "22"],
                  ["Source coverage", "31"],
                  ["Entity consistency", "37"],
                  ["Competitive position", "16"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-muted-foreground">{label}</dt>
                    <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
                  </div>
                ))}
              </dl>
              <div className="mt-3">
                <IllustrativeLabel>Illustrative diagnostic, not client data</IllustrativeLabel>
              </div>
            </div>
          </div>
        </div>
        <p className="mt-5 max-w-[65ch] text-xs text-muted-foreground">
          The AI Visibility Index is our framework for comparing observable
          signals and outcomes. It does not represent access to, or knowledge of,
          proprietary model-ranking systems.
        </p>
      </Section>

      {/* 06 — competitive diagnosis */}
      <Section bordered>
        <SectionHeading
          eyebrow="Diagnosis"
          title="Knowing you're underrepresented isn't enough."
          lede="We investigate why the gap may exist, by comparing the information environment around the teams AI recommends with the one around yours."
          serifClass={serif.className}
        />
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          <div className="rounded-lg border p-5">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="text-lg font-medium">Competitor A</h3>
              <p className="text-xs text-muted-foreground">Recommended frequently</p>
            </div>
            <ul className="mt-3">
              <SignalRow state="present">Strong third-party source coverage</SignalRow>
              <SignalRow state="present">Consistent entity information</SignalRow>
              <SignalRow state="present">Strong neighborhood and category associations</SignalRow>
              <SignalRow state="present">Appears in relevant comparison content</SignalRow>
              <SignalRow state="present">Multiple corroborating authority sources</SignalRow>
            </ul>
          </div>
          <div className="rounded-lg border p-5">
            <div className="flex items-baseline justify-between gap-4">
              <h3 className="text-lg font-medium">Your team</h3>
              <p className="text-xs text-muted-foreground">Strong real-world business</p>
            </div>
            <ul className="mt-3">
              <SignalRow state="partial">Strong offline reputation</SignalRow>
              <SignalRow state="missing">Limited third-party category coverage</SignalRow>
              <SignalRow state="partial">Entity signals inconsistent across sources</SignalRow>
              <SignalRow state="missing">Weak coverage for high-intent buyer questions</SignalRow>
              <SignalRow state="missing">Fewer sources available to support recommendations</SignalRow>
            </ul>
          </div>
        </div>
        <p className="mt-5 max-w-[65ch] text-xs text-muted-foreground">
          Illustrative comparison. These indicators are evidence for diagnosis,
          not claims of direct algorithmic causation.
        </p>
      </Section>

      {/* 07 — recommendation moments */}
      <Section bordered>
        <SectionHeading
          title="These aren't searches. They're recommendation moments."
          lede="Buyers and sellers increasingly ask AI systems questions that once went to Google, friends, brokers, or referral networks."
          serifClass={serif.className}
        />
        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {RECOMMENDATION_MOMENTS.map((q) => (
            <p
              key={q}
              className={`${serif.className} rounded-lg border p-5 text-lg italic leading-snug`}
            >
              &ldquo;{q}&rdquo;
            </p>
          ))}
        </div>
        <p className="mt-6 max-w-[65ch] text-sm text-muted-foreground">
          The commercial value isn&apos;t appearing in more AI answers. It&apos;s
          being present in the answers that influence consideration. High-intent
          prompts beat vanity visibility.
        </p>
      </Section>

      {/* 08 — the system */}
      <Section bordered id="system">
        <SectionHeading
          eyebrow="The system"
          title="Measure. Diagnose. Engineer. Verify."
          serifClass={serif.className}
        />
        <div className="mt-8 grid gap-px overflow-hidden rounded-lg border bg-border sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              name: "Measure",
              body: "We build a structured prompt set around the buyer and seller questions that matter in your market, then test how major AI systems respond.",
              items: ["Prompt universe", "Model coverage", "Repeat testing", "Competitive baseline"],
            },
            {
              name: "Diagnose",
              body: "We analyze where competitors outperform you and investigate the sources, entities, content patterns and authority signals associated with those outcomes.",
              items: ["Citation analysis", "Entity analysis", "Competitive sources", "Content and authority gaps"],
            },
            {
              name: "Engineer",
              body: "We prioritize and implement evidence-backed interventions designed to improve how clearly your brand and market authority are represented.",
              items: ["Entity optimization", "Content architecture", "Source development", "Structured information"],
            },
            {
              name: "Verify",
              body: "We rerun the same measurement framework and compare the results against the original baseline.",
              items: ["Before / after", "Recommendation share", "Prompt coverage", "Competitive gap"],
            },
          ].map((stage) => (
            <div key={stage.name} className="bg-background p-5">
              <h3 className="text-lg font-medium">{stage.name}</h3>
              <p className="mt-1.5 text-sm text-muted-foreground">{stage.body}</p>
              <ul className="mt-3 space-y-1 text-xs text-muted-foreground">
                {stage.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className={`${serif.className} mt-8 text-balance text-2xl font-medium tracking-tight`}>
          We do not stop at optimization. We measure again.
        </p>
      </Section>

      {/* 09 — evidence standard */}
      <Section bordered>
        <SectionHeading
          eyebrow="Evidence standard"
          title="Every conclusion should have a trail."
          lede="AI visibility is noisy. Model outputs change. Correlation is not causation. Our methodology is designed around those realities rather than pretending they don't exist."
          serifClass={serif.className}
        />
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {[
            {
              name: "Observed",
              body: "What the AI system actually returned during controlled testing: answer text, brand mentions, position, citations, model, prompt, timestamp.",
            },
            {
              name: "Attributed",
              body: "The sources, entities, and information structures associated with the observed response.",
            },
            {
              name: "Diagnosed",
              body: "Evidence-supported hypotheses explaining competitive visibility gaps.",
            },
            {
              name: "Verified",
              body: "Follow-up measurement after interventions, using the same framework wherever possible.",
            },
          ].map((card) => (
            <div key={card.name} className="rounded-lg border p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {card.name}
              </p>
              <p className="mt-2 text-sm">{card.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-8 rounded-lg border p-5">
          <p className="text-sm font-medium">How we classify what we tell you</p>
          <dl className="mt-3 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            {[
              ["Observed fact", "Directly captured."],
              ["Supported finding", "Backed by multiple pieces of evidence."],
              ["Working hypothesis", "Plausible explanation requiring further testing."],
              ["Unknown", "Evidence is insufficient. We say so."],
            ].map(([term, def]) => (
              <div key={term} className="flex items-baseline gap-3">
                <dt className="shrink-0 font-medium">{term}</dt>
                <dd className="text-muted-foreground">{def}</dd>
              </div>
            ))}
          </dl>
        </div>
      </Section>

      {/* 10 — what we actually change */}
      <Section bordered>
        <SectionHeading
          title="We improve the information environment around your brand."
          lede="The specific intervention depends on the diagnosis. There is no universal checklist, and not every client needs every intervention."
          serifClass={serif.className}
        />
        <div className="mt-8 grid gap-x-10 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
          {INTERVENTION_AREAS.map((area) => (
            <div key={area.title} className="border-t pt-4">
              <h3 className="text-sm font-medium">{area.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{area.body}</p>
            </div>
          ))}
        </div>
        <p className="mt-8 max-w-[65ch] text-sm text-muted-foreground">
          We prioritize interventions by evidence, expected impact, feasibility,
          and confidence, not by a predetermined checklist.
        </p>
      </Section>

      {/* 11 — GEO vs SEO */}
      <Section bordered>
        <SectionHeading
          title="Ranking a webpage and being recommended as a brand are different problems."
          serifClass={serif.className}
        />
        <div className="mt-8 grid gap-6 md:grid-cols-2">
          <div className="rounded-lg border p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Traditional search
            </p>
            <p className={`${serif.className} mt-3 text-lg italic`}>
              &ldquo;luxury realtor NYC&rdquo;
            </p>
            <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
              <li>Website</li>
              <li>Website</li>
              <li>Website</li>
            </ol>
            <p className="mt-4 text-sm">
              Primary optimization object:{" "}
              <span className="font-medium">the webpage</span>
            </p>
          </div>
          <div className="rounded-lg border p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              AI recommendation
            </p>
            <p className={`${serif.className} mt-3 text-lg italic`}>
              &ldquo;Who should I use to sell my luxury condo in Tribeca?&rdquo;
            </p>
            <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
              <li>Understands intent</li>
              <li>Identifies candidates and compares entities</li>
              <li>Synthesizes sources and assesses evidence</li>
              <li>Generates a recommendation</li>
            </ul>
            <p className="mt-4 text-sm">
              Primary optimization object:{" "}
              <span className="font-medium">
                the brand&apos;s representation across the information environment
              </span>
            </p>
          </div>
        </div>
        <p className="mt-6 max-w-[65ch] text-sm text-muted-foreground">
          Traditional SEO remains important. AI visibility builds on many of the
          same foundations but introduces a different measurement problem:
          whether AI systems understand, trust, and surface the brand itself.
        </p>
      </Section>

      {/* 12 — done-for-you */}
      <Section bordered>
        <SectionHeading
          eyebrow="Execution"
          title="This isn't another strategy deck for your team to implement."
          lede="We identify the visibility gaps, prioritize the interventions, execute what we can directly, coordinate what requires your team or partners, and continuously measure the results."
          serifClass={serif.className}
        />
        <div className="mt-8 grid gap-6 sm:grid-cols-3">
          {[
            {
              name: "We analyze",
              items: ["Prompt performance", "Competitors", "Sources", "Entities", "Authority", "Content"],
            },
            {
              name: "We prioritize",
              items: ["Impact", "Evidence", "Confidence", "Effort", "Dependencies"],
            },
            {
              name: "We execute and verify",
              items: ["Implementation", "QA", "Monitoring", "Retesting", "Reporting"],
            },
          ].map((col) => (
            <div key={col.name} className="border-t pt-4">
              <h3 className="text-sm font-medium">{col.name}</h3>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                {col.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ))}
        </div>
        <p className="mt-8 max-w-[65ch] text-sm">
          Your team should not need to become experts in AI optimization to
          benefit from it.
        </p>
      </Section>

      {/* 13 — measurement dashboard */}
      <Section bordered>
        <SectionHeading
          title="Progress should be visible before the final outcome is known."
          lede="Different indicators move at different speeds. We track leading indicators alongside observed recommendation outcomes, so an engagement is never a black box between kickoff and results."
          serifClass={serif.className}
        />
        <div className="mt-8 rounded-lg border">
          <div className="border-b px-5 py-3">
            <IllustrativeLabel>Illustrative dashboard, not client data</IllustrativeLabel>
          </div>
          <div className="grid grid-cols-2 gap-x-6 gap-y-8 p-5 sm:grid-cols-3">
            <DataPoint label="AI recommendation share" value="21% → 28%" />
            <DataPoint label="High-intent prompt coverage" value="33% → 47%" />
            <DataPoint label="Citation / source coverage" value="14 → 23" />
            <DataPoint label="Entity consistency" value="61% → 84%" />
            <DataPoint label="Competitive visibility gap" value="−38 → −22 pts" />
            <DataPoint label="Implemented interventions" value="17 / 22" />
          </div>
        </div>
        <p className="mt-4 max-w-[65ch] text-xs text-muted-foreground">
          These deltas illustrate the reporting format, not typical or promised
          outcomes.
        </p>
      </Section>

      {/* 14 — baseline / intervention / retest */}
      <Section bordered>
        <SectionHeading
          title="Baseline. Intervention. Retest."
          serifClass={serif.className}
        />
        <ol className="mt-8 grid gap-6 sm:grid-cols-3">
          {[
            {
              name: "Baseline",
              items: [
                "Measurement window established",
                "Prompt universe locked",
                "Competitors benchmarked",
                "Evidence captured immutably",
              ],
            },
            {
              name: "Intervention",
              items: ["Priority actions implemented", "Changes documented", "Dependencies tracked"],
            },
            {
              name: "Retest",
              items: [
                "Prompt set rerun",
                "Outputs captured",
                "Differences measured",
                "Confidence assessed",
              ],
            },
          ].map((phase, i) => (
            <li key={phase.name} className="rounded-lg border p-5">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {i + 1} · {phase.name}
              </p>
              <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
                {phase.items.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
      </Section>

      {/* 15 — sample audit */}
      <Section bordered>
        <SectionHeading
          title="Start with the evidence."
          lede="Before deciding whether an engagement makes sense, see what our analysis actually looks like."
          serifClass={serif.className}
        />
        <div className="mt-8 grid gap-8 lg:grid-cols-[3fr_2fr] lg:items-start">
          <div className="rounded-lg border p-6">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Sample audit · contents
            </p>
            <ul className="mt-3 grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
              {[
                "AI Recommendation Share",
                "Competitive gap",
                "Prompt-level results",
                "Citation analysis",
                "Entity findings",
                "Priority opportunities",
                "Evidence confidence",
                "Methodology and limitations",
              ].map((item) => (
                <li key={item} className="text-muted-foreground">
                  {item}
                </li>
              ))}
            </ul>
            <div className="mt-4 border-t pt-4">
              <IllustrativeLabel>Sample report with illustrative data</IllustrativeLabel>
            </div>
          </div>
          <div>
            <p className="max-w-[55ch] text-sm text-muted-foreground">
              The sample reads like an intelligence dossier, not a sales
              brochure: every claim classified, every figure traceable, every
              limitation stated.
            </p>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <SampleAuditCta />
            </div>
          </div>
        </div>
      </Section>

      {/* 16 — example measurement framework (no invented case studies) */}
      <Section bordered>
        <SectionHeading
          title="What a result will look like."
          lede="We publish no case studies until we have client-approved, verified measurements to show. When we do, each one will carry this structure."
          serifClass={serif.className}
        />
        <div className="mt-8 rounded-lg border p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Case study format
            </p>
            <ConfidenceBadge level="unknown" />
          </div>
          <dl className="mt-4 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            {[
              ["Client type and market", "Stated, with the client's approval"],
              ["Measurement window", "Exact dates, baseline and follow-up"],
              ["Baseline recommendation share", "Counted from captured answers"],
              ["Primary diagnosis", "Evidence-backed, classification attached"],
              ["Interventions", "Documented actions, numbered"],
              ["Follow-up results", "Same framework, differences measured"],
            ].map(([term, def]) => (
              <div key={term}>
                <dt className="font-medium">{term}</dt>
                <dd className="mt-0.5 text-muted-foreground">{def}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 border-t pt-4 text-xs text-muted-foreground">
            One rigorous, inspectable case study is worth more than twenty vague
            testimonials. Until then, this slot stays honest and empty.
          </p>
        </div>
      </Section>

      {/* 17 — who it's for */}
      <Section bordered>
        <SectionHeading
          eyebrow="Fit"
          title="Built for teams with real authority worth protecting."
          serifClass={serif.className}
        />
        <div className="mt-8 grid gap-x-10 gap-y-6 sm:grid-cols-2">
          {[
            {
              title: "Market-leading agents",
              body: "Significant transaction history and established expertise.",
            },
            {
              title: "High-performing teams",
              body: "Real-world authority that may be underrepresented by AI.",
            },
            {
              title: "Luxury specialists",
              body: "Businesses where one incremental relationship carries significant economic value.",
            },
            {
              title: "Leaders entering new categories",
              body: "Expansion into a neighborhood, property class, city, or client segment.",
            },
          ].map((fit) => (
            <div key={fit.title} className="border-t pt-4">
              <h3 className="text-sm font-medium">{fit.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{fit.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-10 max-w-3xl">
          <h3 className="text-lg font-medium">Probably not a fit if:</h3>
          <ul className="mt-3 space-y-1.5 text-sm text-muted-foreground">
            <li>You have little real-world track record yet.</li>
            <li>You want promised ChatGPT rankings or a short-term ranking hack.</li>
            <li>You expect AI systems to be directly controllable.</li>
            <li>You only want bulk content production.</li>
          </ul>
        </div>
      </Section>

      {/* 18 — market exclusivity */}
      <Section bordered>
        <SectionHeading
          title="We don't engineer the same advantage for direct competitors."
          lede="Where appropriate, we limit engagements with directly competing teams inside clearly defined markets. Exclusivity is defined during qualification based on geography, property segment, and competitive overlap."
          serifClass={serif.className}
        />
        <p className="mt-4 max-w-[65ch] text-sm text-muted-foreground">
          This is conflict-of-interest management, not scarcity marketing. Every
          engagement is checked against existing commitments before we proceed.
        </p>
      </Section>

      {/* 19 — why now */}
      <Section bordered>
        <SectionHeading
          title="The recommendation layer of the internet is being rebuilt."
          lede="Consumers increasingly use AI systems to research options, compare businesses, and ask for recommendations. For real estate brands, this creates a new visibility surface alongside search, portals, referrals, and traditional media."
          serifClass={serif.className}
        />
        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div className="rounded-lg border p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Search engine
            </p>
            <p className="mt-2 text-sm text-muted-foreground">Query → results</p>
          </div>
          <div className="rounded-lg border p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              AI assistant
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              Question → synthesis → comparison → recommendation
            </p>
          </div>
        </div>
        <p className="mt-6 max-w-[65ch] text-sm">
          The brands that understand how they are represented now can build an
          evidence base before the channel fully matures.
        </p>
      </Section>

      {/* 20 — FAQ */}
      <Section bordered id="faq">
        <SectionHeading title="Questions a skeptical operator should ask." serifClass={serif.className} />
        <div className="mt-6 max-w-3xl divide-y border-y">
          {FAQ.map((item) => (
            <details key={item.q} className="group py-4">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 rounded-sm text-sm font-medium transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                {item.q}
                <span
                  aria-hidden
                  className="shrink-0 text-muted-foreground transition-transform duration-200 group-open:rotate-45"
                >
                  +
                </span>
              </summary>
              <p className="mt-2 max-w-[65ch] text-sm text-muted-foreground">{item.a}</p>
            </details>
          ))}
        </div>
      </Section>

      {/* 21 — primary conversion */}
      <Section bordered id="request">
        <SectionHeading
          eyebrow="Your baseline"
          title="Find out how AI sees your brand."
          lede="See where your team appears, which competitors are being recommended, and where the largest visibility gaps may exist."
          serifClass={serif.className}
        />
        <div className="mt-8">
          <RequestForm />
        </div>
        <p className={`${serif.className} mt-12 text-lg italic text-muted-foreground`}>
          Evidence first. Recommendations second.
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          Prefer to see the work before requesting anything?{" "}
          <Link
            href="/sample-audit"
            className="underline underline-offset-2 transition-colors hover:text-foreground"
          >
            Explore the sample audit
          </Link>{" "}
          or{" "}
          <Link
            href="/methodology"
            className="underline underline-offset-2 transition-colors hover:text-foreground"
          >
            read the methodology
          </Link>
          .
        </p>
      </Section>
    </div>
  );
}
