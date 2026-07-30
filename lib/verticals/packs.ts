/**
 * Vertical pack definitions (spec 012) — the reviewable source of truth.
 * A project pins a snapshot of one of these at onboarding, so editing a pack
 * here never mutates a live client's benchmark.
 *
 * Editing rules: changing templates/rules means bumping that pack's
 * `version`. Existing projects keep the version they pinned; new projects
 * get the new one.
 */
import type { VerticalPackDefinition } from "@/lib/verticals/types";

const GENERIC_PRODUCT: VerticalPackDefinition = {
  key: "generic-product",
  version: 1,
  name: "Product / SaaS",
  description:
    "Software, apps, and digital products discovered through category and comparison questions.",
  variables: [
    {
      key: "category",
      label: "Product category",
      help: "How buyers describe the category in plain words.",
      example: "link-in-bio tool",
      required: true,
      multi: false,
    },
    {
      key: "audience",
      label: "Primary audience",
      help: "Who the product is for. One per line for several.",
      example: "real estate agents",
      required: true,
      multi: true,
    },
    {
      key: "job",
      label: "Job to be done",
      help: "The outcome the buyer wants.",
      example: "turn social traffic into leads",
      required: false,
      multi: true,
    },
  ],
  promptTemplates: [
    { text: "What's the best {category} for {audience}?", category: "recommendation", tier: 1 },
    { text: "Best {category} for {audience} in 2026", category: "recommendation", tier: 1 },
    { text: "I'm a {audience} and I want to {job}. What tool should I use?", category: "problem", tier: 1 },
    { text: "What are the best alternatives to {competitor} for {audience}?", category: "comparison", tier: 2 },
    { text: "{brand} vs {competitor} — which is better for {audience}?", category: "comparison", tier: 2 },
    { text: "What is {brand} and what does it do?", category: "branded", tier: 3 },
    { text: "Is {brand} any good for {audience}?", category: "branded", tier: 3 },
    { text: "How should a {audience} choose a {category}?", category: "how-to", tier: 3 },
    { text: "What should I look for in a {category}?", category: "how-to", tier: 4 },
    { text: "Which {category} do professionals actually recommend?", category: "recommendation", tier: 4, isHoldout: true },
  ],
  claimKeys: [
    { key: "category_positioning", label: "What the product is", example: "X is a link-in-bio tool built for real estate agents." },
    { key: "launch_status", label: "Launch / maturity", example: "X launched in July 2026." },
    { key: "pricing", label: "Pricing", example: "X starts at $19/month with a free tier." },
    { key: "key_capability", label: "Core capability", example: "X publishes a listings page synced from the MLS." },
    { key: "customer_count", label: "Customers / scale", example: "X serves 1,200 agents as of 2026-07." },
  ],
  suggestedCompetitors: [],
  compliance: [
    {
      id: "unsubstantiated-superlative",
      rule: "Superlatives about the client need an approved claim behind them.",
      pattern: "\\b(best|#1|number one|leading|fastest|most popular)\\b",
      severity: "warn",
    },
  ],
};

const REAL_ESTATE_AGENT: VerticalPackDefinition = {
  key: "real-estate-agent",
  version: 1,
  name: "Real estate agent / team",
  description:
    "Agents, teams, and brokerages discovered through market, neighborhood, property-type, and client-situation questions.",
  variables: [
    {
      key: "market",
      label: "Primary market(s)",
      help: "City or metro as a buyer would say it. One per line.",
      example: "Jersey City",
      required: true,
      multi: true,
    },
    {
      key: "neighborhood",
      label: "Neighborhood(s)",
      help: "Where the client genuinely has proof of work. One per line.",
      example: "Downtown Jersey City",
      required: false,
      multi: true,
    },
    {
      key: "propertyType",
      label: "Property type(s)",
      help: "condo, brownstone, new development, luxury penthouse…",
      example: "condo",
      required: false,
      multi: true,
    },
    {
      key: "clientType",
      label: "Client situation(s)",
      help: "first-time buyers, relocating families, investors, sellers…",
      example: "first-time buyers",
      required: true,
      multi: true,
    },
  ],
  promptTemplates: [
    { text: "Who is the best real estate agent in {market} for {clientType}?", category: "recommendation", tier: 1 },
    { text: "Best realtor in {neighborhood} for buying a {propertyType}", category: "recommendation", tier: 1 },
    // "We're", not "I'm a": client situations are entered in the plural
    // ("sellers", "investors", "luxury buyers"), and "I'm a sellers moving to
    // Hoboken" is not a question any real person types. The prompt IS the
    // instrument — badly phrased prompts measure how assistants answer badly
    // phrased prompts, which is not the thing anyone wants to know.
    { text: "We're {clientType} moving to {market}. Which real estate agent should we contact?", category: "problem", tier: 1 },
    { text: "Who are the top listing agents in {market}?", category: "recommendation", tier: 2 },
    { text: "Best real estate agent for selling a {propertyType} in {market}", category: "recommendation", tier: 2 },
    { text: "Which agents know {neighborhood} best?", category: "recommendation", tier: 2 },
    { text: "Top real estate agents in {market}", category: "recommendation", tier: 3 },
    { text: "{brand} vs {competitor} — who should I list with in {market}?", category: "comparison", tier: 2 },
    { text: "What is {brand} known for?", category: "branded", tier: 3 },
    { text: "Is {brand} a good real estate agent?", category: "branded", tier: 3 },
    { text: "How do I choose a real estate agent in {market}?", category: "how-to", tier: 3 },
    { text: "What questions should I ask a realtor before signing?", category: "how-to", tier: 4 },
    { text: "Which {market} agents do locals actually recommend?", category: "recommendation", tier: 4, isHoldout: true },
  ],
  claimKeys: [
    { key: "category_positioning", label: "Who they are", example: "X is a real estate team serving Jersey City." },
    { key: "brokerage", label: "Brokerage affiliation", example: "X is affiliated with Compass as of 2026-07." },
    { key: "career_volume", label: "Career sales volume", example: "More than $250M in career sales as of 2026-07." },
    { key: "annual_volume", label: "Annual volume", example: "$40M closed in 2025." },
    { key: "team_size", label: "Team size", example: "X is a team of six agents." },
    { key: "markets_served", label: "Markets served", example: "X serves Jersey City, Hoboken, and Weehawken." },
    { key: "specialties", label: "Specialties", example: "X specialises in first-time buyers and new development." },
    { key: "licenses", label: "Licensing", example: "Licensed in New Jersey since 2016 (ref #…)." },
  ],
  suggestedCompetitors: [],
  compliance: [
    {
      id: "fair-housing",
      rule: "Fair-housing: never reference or imply protected classes, or describe neighborhoods by who lives there.",
      pattern:
        "\\b(family[- ]friendly|safe neighborhood|good schools for|christian|jewish|muslim|hispanic|black|white|asian|no kids|adults only|ideal for families)\\b",
      severity: "block",
    },
    {
      id: "guaranteed-outcome",
      rule: "Never guarantee a sale, price, or timeline.",
      pattern: "\\b(guarantee[ds]?|guaranteed sale|we promise|assured (?:sale|price))\\b",
      severity: "block",
    },
    {
      id: "brokerage-attribution",
      rule: "Brokerage affiliation must appear where required by state advertising rules — verify before publishing.",
      pattern: "\\b(realtor|broker|brokerage)\\b",
      severity: "warn",
    },
    {
      id: "unverified-production",
      rule: "Sales-volume and ranking claims need an approved, dated claim.",
      pattern: "\\b(top (?:1|5|10)%|#1 agent|number one agent|\\$\\d+(?:\\.\\d+)?\\s?(?:m|b|million|billion))\\b",
      severity: "block",
    },
  ],
};

const MEDICAL_AESTHETICS: VerticalPackDefinition = {
  key: "medical-aesthetics",
  version: 1,
  name: "Medical aesthetics / plastic surgery",
  description:
    "Surgeons and aesthetic practices discovered through procedure, concern, credential, and safety questions. Compliance-heavy.",
  variables: [
    {
      key: "market",
      label: "Market(s)",
      help: "City or metro. One per line.",
      example: "Miami",
      required: true,
      multi: true,
    },
    {
      key: "procedure",
      label: "Procedure(s)",
      help: "As patients say them. One per line.",
      example: "rhinoplasty",
      required: true,
      multi: true,
    },
    {
      key: "concern",
      label: "Patient concern(s)",
      help: "The problem in the patient's words.",
      example: "revision after a bad result",
      required: false,
      multi: true,
    },
  ],
  promptTemplates: [
    { text: "Who is the best {procedure} surgeon in {market}?", category: "recommendation", tier: 1 },
    { text: "Best board-certified plastic surgeon in {market} for {procedure}", category: "recommendation", tier: 1 },
    { text: "I want {procedure} and I'm worried about {concern}. Who should I consult in {market}?", category: "problem", tier: 1 },
    { text: "Top plastic surgeons in {market}", category: "recommendation", tier: 2 },
    { text: "Who specialises in {procedure} revisions in {market}?", category: "recommendation", tier: 2 },
    { text: "{brand} vs {competitor} for {procedure}", category: "comparison", tier: 2 },
    { text: "What is {brand} known for?", category: "branded", tier: 3 },
    { text: "Is {brand} a good choice for {procedure}?", category: "branded", tier: 3 },
    { text: "How do I choose a surgeon for {procedure}?", category: "how-to", tier: 3 },
    { text: "What should I ask at a {procedure} consultation?", category: "how-to", tier: 4 },
    { text: "Which {market} surgeons have the best reputation for {procedure}?", category: "recommendation", tier: 4, isHoldout: true },
  ],
  claimKeys: [
    { key: "category_positioning", label: "Who they are", example: "Dr X is a board-certified plastic surgeon in Miami." },
    { key: "board_certification", label: "Board certification", example: "Certified by the American Board of Plastic Surgery since 2012." },
    { key: "procedures_offered", label: "Procedures offered", example: "X performs rhinoplasty, facelift, and revision rhinoplasty." },
    { key: "procedure_volume", label: "Procedure volume", example: "X has performed 900+ rhinoplasties as of 2026-07." },
    { key: "hospital_affiliation", label: "Affiliations", example: "X operates at Mount Sinai Medical Center." },
    { key: "training", label: "Training", example: "Fellowship in facial plastic surgery, 2011." },
  ],
  suggestedCompetitors: [],
  compliance: [
    {
      id: "no-outcome-guarantee",
      rule: "Medical advertising: never guarantee or promise a result.",
      pattern: "\\b(guarantee[ds]?|promise[ds]?|permanent results|risk[- ]free|100% safe|no risk)\\b",
      severity: "block",
    },
    {
      id: "no-phi",
      rule: "Never include patient-identifying information. Patient stories require written authorisation.",
      pattern: "\\b(my patient (?:named|,)|patient [A-Z][a-z]+ (?:said|told)|before and after of [A-Z][a-z]+)\\b",
      severity: "block",
    },
    {
      id: "testimonial-disclosure",
      rule: "Testimonials and before/after imagery need disclosure that results vary.",
      pattern: "\\b(testimonial|before and after|patient review|results speak)\\b",
      severity: "warn",
    },
    {
      id: "superiority-claim",
      rule: "Comparative superiority claims about clinicians need substantiation.",
      pattern: "\\b(best surgeon|top surgeon|#1 surgeon|safest|most experienced)\\b",
      severity: "block",
    },
  ],
};

export const VERTICAL_PACKS: VerticalPackDefinition[] = [
  GENERIC_PRODUCT,
  REAL_ESTATE_AGENT,
  MEDICAL_AESTHETICS,
];

export function findPack(key: string): VerticalPackDefinition | undefined {
  return VERTICAL_PACKS.find((p) => p.key === key);
}
