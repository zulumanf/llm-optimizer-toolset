/**
 * The domain event catalogue.
 *
 * Every event this platform can publish is declared here with its payload
 * schema and version. `publishEvent` validates against this catalogue and
 * refuses an unknown type — which is the difference between an event bus and a
 * message-shaped free-for-all.
 *
 * Versioning rule: changing a payload shape means adding a new version entry
 * and keeping the old schema readable. Consumers declare which versions they
 * accept (`event_subscriptions.accepted_versions`), so a producer can move
 * forward without breaking a subscriber mid-flight.
 */
import { z } from "zod";

/** A money-free, PII-light base every payload extends. */
const withReason = z.object({ reason: z.string().default("") });

// -------------------------------------------------------------- client
const clientCreated = z.object({
  projectName: z.string(),
  tier: z.string().default("standard"),
});
const clientOnboarding = z.object({
  checklistId: z.string().optional(),
  step: z.string().default(""),
});

// ----------------------------------------------------------- benchmark
const benchmarkLifecycle = z.object({
  runId: z.string(),
  promptSetVersionId: z.string().optional(),
  cellsTotal: z.number().int().nonnegative().default(0),
  cellsSucceeded: z.number().int().nonnegative().default(0),
});

// ---------------------------------------------------------- visibility
/**
 * A materiality event. `deltaPct` and `sampleSize` are both required because a
 * movement without its sample is a number we are not willing to act on.
 */
const visibilityMovement = z.object({
  metric: z.string(),
  previous: z.number(),
  current: z.number(),
  deltaPct: z.number(),
  sampleSize: z.number().int().nonnegative(),
  periodStart: z.string(),
  periodEnd: z.string(),
  material: z.boolean().default(true),
});

// -------------------------------------------------------------- knowledge
// Specs 020-024. Only types this codebase actually publishes are declared —
// a catalogue entry with no producer is a promise, not a contract.
const sourceRef = z.object({
  sourceArtifactId: z.string(),
  sourceType: z.string(),
  mimeType: z.string().default(""),
  sha256: z.string().default(""),
});
const sourceExtractionFailure = sourceRef.extend({
  extractorKey: z.string(),
  extractorVersion: z.string(),
  error: z.string(),
});
const sourceSuperseded = sourceRef.extend({ supersedesId: z.string() });

const instructionRef = z.object({
  instructionId: z.string(),
  instructionType: z.string(),
  scope: z.string().default("project"),
  version: z.number().int().positive().default(1),
});

const wikiPageRef = z.object({
  pageId: z.string(),
  slug: z.string(),
  pageType: z.string().default(""),
});
const wikiPageStale = wikiPageRef.extend({ reason: z.string().default("") });
const wikiBuildRef = z.object({
  buildId: z.string(),
  pages: z.number().int().nonnegative().default(0),
  compiled: z.number().int().nonnegative().default(0),
  noOp: z.number().int().nonnegative().default(0),
  failed: z.number().int().nonnegative().default(0),
});
const wikiBuildFailure = wikiBuildRef.extend({ error: z.string() });

const contextPacketRef = z.object({
  packetId: z.string(),
  templateKey: z.string(),
  agentKey: z.string().default(""),
  tokenCount: z.number().int().nonnegative().default(0),
});
const contextPacketRejected = z.object({
  templateKey: z.string(),
  agentKey: z.string().default(""),
  reason: z.string(),
});

// --------------------------------------------------------------- claim
const claimRef = z.object({ claimId: z.string(), subject: z.string().default("") });
const claimExpiry = claimRef.extend({ expiresAt: z.string() });
const claimConflict = claimRef.extend({
  conflictingClaimId: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
});

// ------------------------------------------------------------- content
const contentOpportunity = z.object({
  opportunityId: z.string(),
  title: z.string(),
  commercialValue: z.number().min(0).max(1).default(0),
  evidenceGap: z.number().min(0).max(1).default(0),
});
const contentAsset = z.object({
  assetId: z.string(),
  versionId: z.string().optional(),
  url: z.string().optional(),
});

// ------------------------------------------------------------- profile
const profileError = z.object({
  profileType: z.string(),
  profileUrl: z.string(),
  findingId: z.string().optional(),
  severity: z.enum(["low", "medium", "high", "critical"]).default("medium"),
});

// --------------------------------------------------------- transaction
const transactionRef = z.object({
  transactionId: z.string(),
  address: z.string().default(""),
  verified: z.boolean().default(false),
});

// ---------------------------------------------------------------- lead
const leadCreated = z.object({
  leadId: z.string(),
  email: z.string(),
  company: z.string().default(""),
  sourceChannel: z.string().default("unknown"),
});
const leadQualified = z.object({
  leadId: z.string(),
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
});
const leadAiDiscovery = z.object({
  leadId: z.string(),
  /** Self-reported discovery text, verbatim. Never inferred. */
  reportedText: z.string(),
  assistant: z.string().default("unspecified"),
});

// --------------------------------------------------------- opportunity
const opportunityRef = z.object({
  opportunityId: z.string(),
  stage: z.string().default(""),
  amountCents: z.number().int().nonnegative().optional(),
});
const opportunityStage = opportunityRef.extend({ previousStage: z.string() });

// --------------------------------------------------------- integration
const integrationFailure = z.object({
  connectionId: z.string(),
  provider: z.string(),
  errorCode: z.string().default(""),
  severity: z.enum(["low", "medium", "high", "critical"]).default("high"),
});

// ------------------------------------------------------------ approval
const approvalRef = z.object({
  approvalId: z.string(),
  actionType: z.string(),
  riskLevel: z.string().default("low"),
});
const approvalDecided = approvalRef.extend({
  decidedBy: z.string(),
  rationale: z.string().default(""),
});

// ------------------------------------------------------------- invoice
const invoiceRef = z.object({
  invoiceId: z.string(),
  amountCents: z.number().int(),
  currency: z.string().default("USD"),
  dueDate: z.string().optional(),
});

// ------------------------------------------------------------- meeting
const meetingRef = z.object({
  externalEventId: z.string(),
  title: z.string().default(""),
  startsAt: z.string().optional(),
});
const meetingCompleted = meetingRef.extend({
  notes: z.string().default(""),
  transcriptRef: z.string().optional(),
});

// ------------------------------------------------------------- support
const supportMessage = z.object({
  senderEmail: z.string(),
  subject: z.string().default(""),
  body: z.string(),
});

// ------------------------------------------------------------ prospect
const prospectIdentified = z.object({
  prospectId: z.string(),
  name: z.string(),
  company: z.string().default(""),
  website: z.string().default(""),
  market: z.string().default(""),
});

export interface EventTypeDefinition {
  type: string;
  version: number;
  description: string;
  schema: z.ZodTypeAny;
  /** Whether a client scope is required. Platform events may omit it. */
  requiresProject: boolean;
}

function def(
  type: string,
  description: string,
  schema: z.ZodTypeAny,
  requiresProject = true,
  version = 1
): EventTypeDefinition {
  return { type, version, description, schema, requiresProject };
}

export const EVENT_CATALOG: EventTypeDefinition[] = [
  def("client.created", "A client engagement was created", clientCreated),
  def("client.onboarding_started", "Onboarding began", clientOnboarding),
  def("client.onboarding_completed", "Onboarding gates all passed", clientOnboarding),

  def("benchmark.started", "A measurement run began", benchmarkLifecycle),
  def("benchmark.completed", "A measurement run finished completely", benchmarkLifecycle),
  def(
    "benchmark.partially_failed",
    "A measurement run finished with an incomplete sample — disclosed, never hidden",
    benchmarkLifecycle
  ),

  def("visibility.materially_declined", "Visibility fell past the materiality threshold", visibilityMovement),
  def("visibility.materially_improved", "Visibility rose past the materiality threshold", visibilityMovement),

  def("claim.created", "A claim entered the knowledge graph", claimRef),
  def("claim.proposed", "A claim was proposed and awaits verification", claimRef),
  def("claim.expired", "A claim's evidence passed its freshness window", claimExpiry),
  def("claim.conflict_detected", "Two claims contradict each other", claimConflict),
  def("claim.conflict_resolved", "A human resolved or dismissed a contradiction", claimConflict),
  def("claim.approved", "A human approved a claim", claimRef),
  def("claim.superseded", "A newer approved version replaced a claim", claimRef),

  def("source.ingested", "A raw source artifact entered the knowledge layer", sourceRef),
  def(
    "source.extraction_failed",
    "A stored source could not be parsed — the artifact is kept, the parse is not",
    sourceExtractionFailure
  ),
  def("source.superseded", "A newer version of a source replaced an earlier one", sourceSuperseded),

  def("instruction.created", "An operating instruction was created", instructionRef),
  def("instruction.updated", "An operating instruction gained a new version", instructionRef),
  def("instruction.expired", "An instruction passed its effective window", instructionRef),

  def("wiki.page_marked_stale", "A canonical change invalidated a compiled page", wikiPageStale),
  def("wiki.page_build_started", "A knowledge build began", wikiBuildRef),
  def("wiki.page_build_completed", "A knowledge build finished", wikiBuildRef),
  def("wiki.page_build_failed", "A knowledge build failed outright", wikiBuildFailure),

  def("context.packet_created", "A task context packet was assembled", contextPacketRef),
  def(
    "context.packet_rejected",
    "A packet failed validation and was never handed to an agent",
    contextPacketRejected
  ),

  def("content.opportunity_created", "An evidence gap became a content opportunity", contentOpportunity),
  def("content.approved", "A content asset was approved", contentAsset),
  def("content.published", "A content asset went live", contentAsset),

  def("profile.error_detected", "A public profile contradicts approved facts", profileError),
  def("profile.correction_approved", "A correction was approved for submission", profileError),
  def("profile.correction_verified", "A correction was verified live", profileError),

  def("transaction.created", "A transaction was recorded", transactionRef),
  def("transaction.verified", "A transaction was verified against evidence", transactionRef),

  def("lead.created", "An inbound lead arrived", leadCreated),
  def("lead.qualified", "A lead passed qualification", leadQualified),
  def("lead.ai_discovery_reported", "A lead self-reported discovering the client via an AI assistant", leadAiDiscovery),

  def("opportunity.created", "A CRM opportunity was created", opportunityRef),
  def("opportunity.stage_changed", "A CRM opportunity moved stage", opportunityStage),
  def("opportunity.closed_won", "A CRM opportunity closed won", opportunityRef),

  def("integration.connection_failed", "A connector request failed", integrationFailure),
  def("integration.authorization_expired", "A connector's authorisation expired", integrationFailure),

  def("approval.requested", "An action is waiting on a human", approvalRef),
  def("approval.approved", "A human approved an action", approvalDecided),
  def("approval.rejected", "A human rejected an action", approvalDecided),

  def("invoice.created", "An invoice was created", invoiceRef),
  def("invoice.overdue", "An invoice passed its due date", invoiceRef),
  def("invoice.paid", "An invoice was paid", invoiceRef),

  def("meeting.scheduled", "A meeting appeared on the calendar", meetingRef),
  def("meeting.completed", "A meeting finished and has notes", meetingCompleted),

  def("support.message_received", "A client sent a support message", supportMessage),

  def("prospect.identified", "A prospect entered the pipeline", prospectIdentified, false),
];

const BY_TYPE = new Map<string, EventTypeDefinition>(
  EVENT_CATALOG.map((entry) => [entry.type, entry])
);

export function eventDefinition(type: string): EventTypeDefinition | undefined {
  return BY_TYPE.get(type);
}

export function knownEventTypes(): string[] {
  return [...BY_TYPE.keys()].sort();
}

/** Types grouped by their prefix, for the events UI. */
export function eventTypesByGroup(): Map<string, EventTypeDefinition[]> {
  const groups = new Map<string, EventTypeDefinition[]>();
  for (const entry of EVENT_CATALOG) {
    const group = entry.type.split(".")[0]!;
    groups.set(group, [...(groups.get(group) ?? []), entry]);
  }
  return groups;
}

export { withReason };
