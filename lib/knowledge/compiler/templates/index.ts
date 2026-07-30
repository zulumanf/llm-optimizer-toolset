/**
 * Page templates (spec 023).
 *
 * Each template selects canonical records and renders sections, declaring the
 * dependencies it read in the same pass. Follows the `lib/workflow/templates/`
 * idiom: declarations in code, registered in one list, versioned by string.
 *
 * The rendering rule everywhere below: **no free-floating facts.** A material
 * section states only what a selected claim says, and carries that claim's id
 * in its provenance. If there is no claim, the section says there is no claim —
 * it does not fill the gap with plausible prose.
 */
import { HOT_FILE_TOKEN_BUDGETS } from "@/lib/knowledge/constants";
import { worstFreshness } from "@/lib/knowledge/freshness";
import type {
  CompileContext,
  CompiledClaim,
  PageDependency,
  PageSelection,
  PageTemplate,
  SectionDraft,
} from "@/lib/knowledge/compiler/types";

// ------------------------------------------------------------------ helpers

const NO_PROVENANCE = {
  claimIds: [],
  claimVersionIds: [],
  evidenceIds: [],
  instructionVersionIds: [],
  sourceArtifactIds: [],
};

/** Provenance for a set of claims, in the shape the section table expects. */
function provenanceFor(claims: CompiledClaim[], instructionVersionIds: string[] = []) {
  return {
    claimIds: claims.map((c) => c.id),
    claimVersionIds: claims.map((c) => c.claimVersionId).filter((id): id is string => !!id),
    evidenceIds: [...new Set(claims.flatMap((c) => c.evidenceIds))],
    instructionVersionIds,
    sourceArtifactIds: [...new Set(claims.flatMap((c) => c.sourceArtifactIds))],
  };
}

/** Dependencies implied by a claim set, so a template never has to list twice. */
function claimDependencies(claims: CompiledClaim[]): PageDependency[] {
  const deps: PageDependency[] = [];
  for (const claim of claims) {
    deps.push({ type: "claim", id: claim.id });
    if (claim.claimVersionId) deps.push({ type: "claim_version", id: claim.claimVersionId });
    if (claim.subjectEntityId) deps.push({ type: "entity", id: claim.subjectEntityId });
    for (const evidenceId of claim.evidenceIds) deps.push({ type: "evidence", id: evidenceId });
    for (const sourceId of claim.sourceArtifactIds) {
      deps.push({ type: "source_artifact", id: sourceId });
    }
  }
  return deps;
}

function byCategory(context: CompileContext, categories: string[]): CompiledClaim[] {
  return context.data.claims.filter((c) => categories.includes(c.category));
}

/**
 * Render a claim as a bullet carrying everything an agent needs to use it
 * safely: its id, its date, its freshness, and its wording constraints.
 */
function claimLine(claim: CompiledClaim): string {
  const parts = [`- [claim:${claim.id}] ${claim.canonicalText}`];
  const meta: string[] = [];
  if (claim.asOf) meta.push(`as of ${claim.asOf}`);
  if (claim.freshness !== "current") meta.push(`freshness: ${claim.freshness}`);
  if (claim.verificationStatus !== "verified") {
    meta.push(`verification: ${claim.verificationStatus}`);
  }
  if (claim.allowedWording.length > 0) {
    meta.push(`approved wording: ${claim.allowedWording.join(" | ")}`);
  }
  if (claim.prohibitedWording.length > 0) {
    meta.push(`never say: ${claim.prohibitedWording.join(" | ")}`);
  }
  if (meta.length > 0) parts.push(`\n  _(${meta.join("; ")})_`);
  return parts.join("");
}

function claimSection(args: {
  key: string;
  heading: string;
  claims: CompiledClaim[];
  emptyText: string;
}): SectionDraft {
  return {
    key: args.key,
    heading: args.heading,
    body:
      args.claims.length === 0
        ? `_${args.emptyText}_`
        : args.claims.map(claimLine).join("\n"),
    material: args.claims.length > 0,
    provenance: provenanceFor(args.claims),
  };
}

function selectionFrom(args: {
  title: string;
  summary: string;
  sections: SectionDraft[];
  claims: CompiledClaim[];
  extraDependencies?: PageDependency[];
  structured: Record<string, unknown>;
}): PageSelection {
  return {
    title: args.title,
    summary: args.summary,
    sections: args.sections,
    dependencies: [...claimDependencies(args.claims), ...(args.extraDependencies ?? [])],
    freshness: worstFreshness(args.claims.map((c) => c.freshness)),
    structured: args.structured,
  };
}

// ---------------------------------------------------------------- templates

const identityCategories = ["identity", "affiliation", "team", "licensing"];

export const identityPage: PageTemplate = {
  slug: "identity",
  pageType: "identity",
  title: "Identity",
  templateVersion: "identity-v1",
  privacy: "client_only",
  select(context) {
    const claims = byCategory(context, identityCategories);
    const entities = context.data.entities.filter((e) =>
      ["person", "organization", "brokerage", "team"].includes(e.entityType)
    );
    const sections: SectionDraft[] = [
      claimSection({
        key: "identity-claims",
        heading: "Approved identity facts",
        claims,
        emptyText: "No approved identity claims. Do not state who this client is.",
      }),
      {
        key: "known-entities",
        heading: "Known entities and aliases",
        body:
          entities.length === 0
            ? "_No entities recorded._"
            : entities
                .map(
                  (e) =>
                    `- **${e.canonicalName}** (${e.entityType.replace(/_/g, " ")})${
                      e.aliases.length > 1 ? ` — also known as ${e.aliases.filter((a) => a !== e.canonicalName).join(", ")}` : ""
                    }`
                )
                .join("\n"),
        material: false,
        provenance: NO_PROVENANCE,
      },
    ];
    return selectionFrom({
      title: `${context.projectName} — Identity`,
      summary: `${claims.length} approved identity claims across ${entities.length} known entities.`,
      sections,
      claims,
      extraDependencies: entities.map((e) => ({ type: "entity" as const, id: e.id })),
      structured: { claimCount: claims.length, entities: entities.map((e) => e.canonicalName) },
    });
  },
};

export const approvedClaimsPage: PageTemplate = {
  slug: "approved-claims",
  pageType: "hot_file",
  title: "Approved claims",
  templateVersion: "approved-claims-v1",
  tokenBudget: HOT_FILE_TOKEN_BUDGETS["approved-claims"],
  privacy: "client_only",
  select(context) {
    const claims = context.data.claims;
    const grouped = new Map<string, CompiledClaim[]>();
    for (const claim of claims) {
      grouped.set(claim.category, [...(grouped.get(claim.category) ?? []), claim]);
    }
    const sections: SectionDraft[] = [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, group]) =>
        claimSection({
          key: `claims-${category}`,
          heading: category.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()),
          claims: group,
          emptyText: "None.",
        })
      );
    if (sections.length === 0) {
      sections.push({
        key: "claims-none",
        heading: "Approved claims",
        body: "_No approved claims exist for this client. An agent must not state any client fact._",
        material: false,
        provenance: NO_PROVENANCE,
      });
    }
    return selectionFrom({
      title: `${context.projectName} — Approved claims`,
      summary: `${claims.length} approved claims in ${grouped.size} categories.`,
      sections,
      claims,
      structured: {
        total: claims.length,
        byCategory: Object.fromEntries([...grouped].map(([k, v]) => [k, v.length])),
      },
    });
  },
};

export const marketsPage: PageTemplate = {
  slug: "markets",
  pageType: "markets",
  title: "Markets",
  templateVersion: "markets-v1",
  privacy: "client_only",
  select(context) {
    const claims = byCategory(context, ["market", "neighborhood", "market_statistic"]);
    const markets = context.data.entities.filter((e) =>
      ["market", "neighborhood"].includes(e.entityType)
    );
    return selectionFrom({
      title: `${context.projectName} — Markets`,
      summary: `${markets.length} markets and neighbourhoods, ${claims.length} supporting claims.`,
      sections: [
        claimSection({
          key: "market-claims",
          heading: "Approved market claims",
          claims,
          emptyText: "No approved market claims. Do not state where this client operates.",
        }),
      ],
      claims,
      extraDependencies: markets.map((e) => ({ type: "market" as const, id: e.id })),
      structured: { markets: markets.map((m) => m.canonicalName) },
    });
  },
};

export const specialtiesPage: PageTemplate = {
  slug: "specialties",
  pageType: "specialties",
  title: "Specialties",
  templateVersion: "specialties-v1",
  privacy: "client_only",
  select(context) {
    const claims = byCategory(context, ["specialty", "service"]);
    return selectionFrom({
      title: `${context.projectName} — Specialties`,
      summary: `${claims.length} approved specialty and service claims.`,
      sections: [
        claimSection({
          key: "specialty-claims",
          heading: "Approved specialties",
          claims,
          emptyText: "No approved specialty claims.",
        }),
      ],
      claims,
      structured: { count: claims.length },
    });
  },
};

export const transactionsPage: PageTemplate = {
  slug: "transactions",
  pageType: "transactions",
  title: "Transactions",
  templateVersion: "transactions-v1",
  privacy: "internal",
  select(context) {
    const claims = byCategory(context, ["transaction", "sales_volume"]);
    // Transaction claims are exactly the kind that must never be stated
    // without their date, so the empty text says so rather than shrugging.
    return selectionFrom({
      title: `${context.projectName} — Transactions`,
      summary: `${claims.length} approved transaction and volume claims.`,
      sections: [
        claimSection({
          key: "transaction-claims",
          heading: "Approved transaction facts",
          claims,
          emptyText:
            "No approved transaction claims. Volume and deal counts must not be stated.",
        }),
      ],
      claims,
      structured: { count: claims.length },
    });
  },
};

export const competitorsPage: PageTemplate = {
  slug: "competitors",
  pageType: "competitors",
  title: "Competitors",
  templateVersion: "competitors-v1",
  privacy: "internal",
  select(context) {
    const competitors = context.data.competitors;
    return {
      title: `${context.projectName} — Competitors`,
      summary: `${competitors.length} tracked competitors.`,
      sections: [
        {
          key: "tracked-competitors",
          heading: "Tracked competitors",
          body:
            competitors.length === 0
              ? "_No competitors are tracked for this client._"
              : competitors
                  .map((c) => `- **${c.name}**${c.domain ? ` (${c.domain})` : ""} — ${c.note}`)
                  .join("\n"),
          material: false,
          provenance: NO_PROVENANCE,
        },
      ],
      dependencies: competitors.map((c) => ({ type: "competitor" as const, id: c.id })),
      freshness: "current",
      structured: { competitors: competitors.map((c) => c.name) },
    };
  },
};

export const visibilityPage: PageTemplate = {
  slug: "visibility-performance",
  pageType: "visibility_performance",
  title: "Visibility performance",
  templateVersion: "visibility-v1",
  privacy: "internal",
  select(context) {
    const metrics = context.data.metrics;
    return {
      title: `${context.projectName} — Visibility performance`,
      summary:
        metrics.length === 0
          ? "No scored measurements yet."
          : `${metrics.length} recent metric readings.`,
      sections: [
        {
          key: "metrics",
          heading: "Latest measurements",
          body:
            metrics.length === 0
              ? "_No measurements have been scored. Do not describe visibility performance._"
              : metrics
                  .map(
                    (m) =>
                      `- **${m.metric}**: ${m.value} (n=${m.sampleSize}, scoring ${m.scoringVersion}, ${m.computedAt.slice(0, 10)})`
                  )
                  .join("\n"),
          // Every number carries its sample size and scoring version, because a
          // metric without them is a number we are not willing to act on.
          material: metrics.length > 0,
          provenance: NO_PROVENANCE,
        },
      ],
      dependencies: [],
      freshness: metrics.length === 0 ? "unknown" : "current",
      structured: { metrics },
    };
  },
};

export const openRisksPage: PageTemplate = {
  slug: "open-risks",
  pageType: "hot_file",
  title: "Open risks",
  templateVersion: "open-risks-v1",
  tokenBudget: HOT_FILE_TOKEN_BUDGETS["open-risks"],
  privacy: "internal",
  select(context) {
    const contradictions = context.data.contradictions;
    const unusable = context.data.claims.filter((c) =>
      ["stale", "expired", "unknown"].includes(c.freshness)
    );
    const failedSources = context.data.sources.filter((s) =>
      ["failed", "unsupported"].includes(s.extractionStatus)
    );
    return selectionFrom({
      title: `${context.projectName} — Open risks`,
      summary: `${contradictions.length} open contradictions, ${unusable.length} claims unusable on freshness.`,
      sections: [
        {
          key: "contradictions",
          heading: "Unresolved contradictions",
          body:
            contradictions.length === 0
              ? "_None._"
              : contradictions
                  .map((c) => `- **[${c.severity}]** ${c.description} _(claim:${c.claimId})_`)
                  .join("\n"),
          material: contradictions.length > 0,
          provenance: {
            ...NO_PROVENANCE,
            claimIds: contradictions.map((c) => c.claimId),
          },
        },
        claimSection({
          key: "unusable-claims",
          heading: "Claims that must not be stated as current",
          claims: unusable,
          emptyText: "None — every approved claim is inside its review window.",
        }),
        {
          key: "unreadable-sources",
          heading: "Sources held but not readable",
          body:
            failedSources.length === 0
              ? "_None._"
              : failedSources
                  .map((s) => `- ${s.label} (${s.sourceType}) — ${s.extractionStatus}`)
                  .join("\n"),
          material: false,
          provenance: NO_PROVENANCE,
        },
      ],
      claims: unusable,
      extraDependencies: [
        ...failedSources.map((s) => ({ type: "source_artifact" as const, id: s.id })),
        // A contradiction section cites the disputed claim, so the page depends
        // on it — otherwise resolving the contradiction would not rebuild this
        // page, and the validator rejects the mismatch (correctly).
        ...contradictions.map((c) => ({ type: "claim" as const, id: c.claimId })),
      ],
      structured: {
        contradictions: contradictions.length,
        unusableClaims: unusable.length,
        unreadableSources: failedSources.length,
      },
    });
  },
};

export const activeActionsPage: PageTemplate = {
  slug: "active-actions",
  pageType: "hot_file",
  title: "Active actions",
  templateVersion: "active-actions-v1",
  tokenBudget: HOT_FILE_TOKEN_BUDGETS["active-actions"],
  privacy: "internal",
  select(context) {
    const actions = context.data.actions;
    return {
      title: `${context.projectName} — Active actions`,
      summary: `${actions.length} open actions.`,
      sections: [
        {
          key: "open-actions",
          heading: "Open actions",
          body:
            actions.length === 0
              ? "_No open actions._"
              : actions
                  .map(
                    (a) =>
                      `- **${a.title}** — ${a.kind.replace(/_/g, " ")}, ${a.status} (opened ${a.createdAt.slice(0, 10)})`
                  )
                  .join("\n"),
          material: false,
          provenance: NO_PROVENANCE,
        },
      ],
      dependencies: actions.map((a) => ({ type: "action" as const, id: a.id })),
      freshness: "current",
      structured: { open: actions.length },
    };
  },
};

export const recentChangesPage: PageTemplate = {
  slug: "recent-changes",
  pageType: "hot_file",
  title: "Recent changes",
  templateVersion: "recent-changes-v1",
  tokenBudget: HOT_FILE_TOKEN_BUDGETS["recent-changes"],
  privacy: "internal",
  select(context) {
    const changes = context.data.recentChanges;
    return {
      title: `${context.projectName} — Recent changes`,
      summary: `${changes.length} canonical changes in the last 30 days.`,
      sections: [
        {
          key: "changes",
          heading: "Canonical changes (last 30 days)",
          body:
            changes.length === 0
              ? "_No canonical changes recorded in the window._"
              : changes
                  .map((c) => `- ${c.at.slice(0, 10)} — ${c.kind.replace(/\./g, " ")}: ${c.subject}`)
                  .join("\n"),
          material: false,
          provenance: NO_PROVENANCE,
        },
      ],
      dependencies: [],
      freshness: "current",
      structured: { count: changes.length },
    };
  },
};

export const currentPrioritiesPage: PageTemplate = {
  slug: "current-priorities",
  pageType: "hot_file",
  title: "Current priorities",
  templateVersion: "current-priorities-v1",
  tokenBudget: HOT_FILE_TOKEN_BUDGETS["current-priorities"],
  privacy: "internal",
  select(context) {
    const claims = byCategory(context, ["strategy", "priority"]);
    const actions = context.data.actions.filter((a) => a.status !== "approved");
    return selectionFrom({
      title: `${context.projectName} — Current priorities`,
      summary: `${actions.length} in-flight actions.`,
      sections: [
        claimSection({
          key: "priority-claims",
          heading: "Approved strategy claims",
          claims,
          emptyText: "No approved strategy claims are recorded.",
        }),
        {
          key: "in-flight",
          heading: "In flight",
          body:
            actions.length === 0
              ? "_Nothing in flight._"
              : actions.map((a) => `- ${a.title} (${a.status})`).join("\n"),
          material: false,
          provenance: NO_PROVENANCE,
        },
      ],
      claims,
      extraDependencies: actions.map((a) => ({ type: "action" as const, id: a.id })),
      structured: { inFlight: actions.length },
    });
  },
};

/**
 * The client summary — the default context for most agents, and the file whose
 * budget matters most. Deliberately assembled from the *material* facts only,
 * with links to the deeper pages rather than their content.
 */
export const clientSummaryPage: PageTemplate = {
  slug: "client-summary",
  pageType: "hot_file",
  title: "Client summary",
  templateVersion: "client-summary-v1",
  tokenBudget: HOT_FILE_TOKEN_BUDGETS["client-summary"],
  privacy: "client_only",
  select(context) {
    const identity = byCategory(context, identityCategories).slice(0, 6);
    const markets = byCategory(context, ["market", "neighborhood"]).slice(0, 6);
    const specialties = byCategory(context, ["specialty", "service"]).slice(0, 6);
    const material = context.data.claims
      .filter((c) => c.materiality !== "ordinary" && c.freshness === "current")
      .slice(0, 8);
    const used = [...identity, ...markets, ...specialties, ...material];

    const restrictions = context.data.instructions.filter((i) => i.isSafety);
    const contradictions = context.data.contradictions.filter((c) =>
      ["high", "critical"].includes(c.severity)
    );

    const sections: SectionDraft[] = [
      claimSection({
        key: "identity",
        heading: "Identity",
        claims: identity,
        emptyText: "No approved identity claims — do not describe who this client is.",
      }),
      claimSection({
        key: "markets",
        heading: "Primary markets",
        claims: markets,
        emptyText: "No approved market claims.",
      }),
      claimSection({
        key: "specialties",
        heading: "Core specialties",
        claims: specialties,
        emptyText: "No approved specialty claims.",
      }),
      claimSection({
        key: "material-claims",
        heading: "Approved material claims",
        claims: material,
        emptyText: "No current material claims. Do not state volume, rankings or superlatives.",
      }),
      {
        key: "restrictions",
        heading: "Important restrictions",
        body:
          restrictions.length === 0
            ? "_No client-specific restrictions are recorded._"
            : restrictions.map((i) => `- **${i.title}**: ${i.body}`).join("\n"),
        material: false,
        provenance: {
          ...NO_PROVENANCE,
          instructionVersionIds: restrictions.map((i) => i.versionId),
        },
      },
      {
        key: "open-risks",
        heading: "Open risks",
        body:
          contradictions.length === 0
            ? "_No high-severity contradictions._"
            : contradictions.map((c) => `- **[${c.severity}]** ${c.description}`).join("\n"),
        material: contradictions.length > 0,
        provenance: { ...NO_PROVENANCE, claimIds: contradictions.map((c) => c.claimId) },
      },
      {
        key: "deeper",
        heading: "Deeper pages",
        body: [
          "- `transactions` — approved transaction and volume facts",
          "- `competitors` — tracked competitors",
          "- `visibility-performance` — scored measurements",
          "- `open-risks` — every contradiction and unusable claim",
        ].join("\n"),
        material: false,
        provenance: NO_PROVENANCE,
      },
    ];

    return selectionFrom({
      title: `${context.projectName} — Client summary`,
      summary: `Compiled summary: ${used.length} claims, ${restrictions.length} restrictions, ${contradictions.length} high-severity contradictions.`,
      sections,
      claims: used,
      extraDependencies: [
        ...restrictions.map((i) => ({ type: "instruction" as const, id: i.id })),
        // Same reason as open-risks: the summary cites the disputed claim, so
        // resolving the contradiction must rebuild the summary.
        ...contradictions.map((c) => ({ type: "claim" as const, id: c.claimId })),
      ],
      structured: {
        identity: identity.length,
        markets: markets.length,
        specialties: specialties.length,
        materialClaims: material.length,
      },
    });
  },
};

export const overviewPage: PageTemplate = {
  slug: "overview",
  pageType: "overview",
  title: "Overview",
  templateVersion: "overview-v1",
  privacy: "client_only",
  select(context) {
    const claims = context.data.claims;
    const stale = claims.filter((c) => c.freshness !== "current");
    return selectionFrom({
      title: `${context.projectName} — Overview`,
      summary: `${claims.length} approved claims, ${context.data.sources.length} held sources, ${context.data.contradictions.length} open contradictions.`,
      sections: [
        {
          key: "state-of-knowledge",
          heading: "State of knowledge",
          body: [
            `- Approved claims: **${claims.length}**`,
            `- Claims outside their review window: **${stale.length}**`,
            `- Sources held: **${context.data.sources.length}**`,
            `- Open contradictions: **${context.data.contradictions.length}**`,
            `- Tracked competitors: **${context.data.competitors.length}**`,
            `- Active instructions: **${context.data.instructions.length}**`,
          ].join("\n"),
          material: false,
          provenance: NO_PROVENANCE,
        },
        claimSection({
          key: "needs-attention",
          heading: "Claims needing attention",
          claims: stale.slice(0, 10),
          emptyText: "Every approved claim is inside its review window.",
        }),
      ],
      claims,
      structured: { claims: claims.length, stale: stale.length },
    });
  },
};

/** Methodology pages are shared across clients — one copy, not one per client. */
export const attributionMethodologyPage: PageTemplate = {
  slug: "methodology-attribution-confidence",
  pageType: "methodology",
  title: "Attribution confidence methodology",
  templateVersion: "methodology-attribution-v1",
  privacy: "internal",
  shared: true,
  select() {
    return {
      title: "Attribution confidence methodology",
      summary: "How attribution confidence is bounded by evidence class.",
      sections: [
        {
          key: "confidence-bounds",
          heading: "Confidence is bounded by evidence class",
          body: [
            "Attribution confidence is never asserted above the evidence that supports it:",
            "",
            "- **self-reported** — a lead said they found the client via an assistant. Confidence is capped; the wording is verbatim, never inferred.",
            "- **correlational** — a measured visibility change precedes a revenue change. State the correlation; never state cause.",
            "- **controlled** — a holdout or A/B design supports the comparison.",
            "",
            "A statement that asserts causation from correlational evidence is an error, not a stylistic choice.",
          ].join("\n"),
          material: false,
          provenance: NO_PROVENANCE,
        },
      ],
      dependencies: [],
      freshness: "current",
      structured: {},
    };
  },
};

export const evidencePolicyPage: PageTemplate = {
  slug: "methodology-evidence-policy",
  pageType: "methodology",
  title: "Evidence policy",
  templateVersion: "methodology-evidence-v1",
  privacy: "internal",
  shared: true,
  select() {
    return {
      title: "Evidence policy",
      summary: "What counts as evidence, and what a claim needs before it may be used.",
      sections: [
        {
          key: "policy",
          heading: "Evidence policy",
          body: [
            "- Raw sources are stored before anything parses them, and are never edited or deleted.",
            "- A claim cites the artifact and the span it came from, not the whole document.",
            "- A material claim requires human approval; an agent may only propose.",
            "- A claim past its review window is stated as historical, with its date, or not at all.",
            "- A failed run is recorded as failed. Missing data stays missing.",
          ].join("\n"),
          material: false,
          provenance: NO_PROVENANCE,
        },
      ],
      dependencies: [],
      freshness: "current",
      structured: {},
    };
  },
};

// ------------------------------------------------------------------ registry

export const CLIENT_PAGE_TEMPLATES: PageTemplate[] = [
  overviewPage,
  identityPage,
  marketsPage,
  specialtiesPage,
  transactionsPage,
  competitorsPage,
  visibilityPage,
  // Hot files last: they summarise, and a summary compiled after its sources
  // reads the same snapshot rather than a half-built one.
  clientSummaryPage,
  approvedClaimsPage,
  currentPrioritiesPage,
  openRisksPage,
  activeActionsPage,
  recentChangesPage,
];

export const SHARED_PAGE_TEMPLATES: PageTemplate[] = [
  attributionMethodologyPage,
  evidencePolicyPage,
];

export const ALL_PAGE_TEMPLATES: PageTemplate[] = [
  ...CLIENT_PAGE_TEMPLATES,
  ...SHARED_PAGE_TEMPLATES,
];

export function getPageTemplate(slug: string): PageTemplate | undefined {
  return ALL_PAGE_TEMPLATES.find((t) => t.slug === slug);
}

/** The hot files, in the order an operator reads them. */
export function hotFileTemplates(): PageTemplate[] {
  return CLIENT_PAGE_TEMPLATES.filter((t) => t.pageType === "hot_file");
}
