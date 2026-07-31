/**
 * Context-packet templates (spec 022 Part 16).
 *
 * A template answers one question: *for this kind of task, what must be
 * present, what must never be present, and how much room is there?*
 *
 * Declared in code and mirrored into `context_packet_templates` by
 * `syncPacketTemplates()`, following the exact pattern `syncAgentRegistry()`
 * already established. Code is the source; the table exists so the UI and audit
 * joins have stable ids.
 */
import { sql } from "@/db/client";
import {
  DEFAULT_PACKET_TOKEN_BUDGET,
  type FreshnessState,
} from "@/lib/knowledge/constants";
import type { InstructionType } from "@/lib/knowledge/instructions/service";
import type { PacketAudience, PrivacyStatus } from "@/lib/knowledge/packet";

export interface PacketTemplate {
  key: string;
  name: string;
  description: string;
  version: string;
  /** Claim categories that must be selected deterministically. */
  requiredCategories: string[];
  /** Instruction types the task cannot be performed safely without. */
  requiredInstructionTypes: InstructionType[];
  /** Categories that must never enter this packet, however relevant they score. */
  excludedCategories: string[];
  /** Compiled hot files included by default. */
  hotFiles: string[];
  defaultTokenBudget: number;
  /** Claims worse than this are excluded and disclosed, never silently used. */
  minFreshness: FreshnessState;
  audience: PacketAudience;
  allowedPrivacy: PrivacyStatus[];
  prohibitedSourceTypes: string[];
  /** True when a packet with no approved claims is useless and must safe-stop. */
  requiresClaims: boolean;
  /** Whether retrieval may add supporting material beyond the required set. */
  allowsRetrieval: boolean;
}

const PUBLIC_ONLY: PrivacyStatus[] = ["public"];
const CLIENT_FACING: PrivacyStatus[] = ["public", "client_only"];
const INTERNAL: PrivacyStatus[] = ["public", "client_only", "internal"];

export const PACKET_TEMPLATES: PacketTemplate[] = [
  {
    key: "response_classification",
    name: "Response classification",
    description:
      "Decide which known companies a captured answer mentions. Needs identity and aliases; needs nothing about strategy or transactions.",
    version: "packet-classification-v1",
    requiredCategories: ["identity", "affiliation", "team", "market", "specialty"],
    requiredInstructionTypes: [],
    // Naming what is excluded matters as much as what is included: a
    // classifier that can see the client's sales figures will start using them.
    excludedCategories: ["transaction", "sales_volume", "strategy", "priority"],
    hotFiles: [],
    defaultTokenBudget: 3_000,
    minFreshness: "stale",
    audience: "internal",
    allowedPrivacy: CLIENT_FACING,
    prohibitedSourceTypes: ["crm_export", "email", "transaction_file"],
    requiresClaims: false,
    allowsRetrieval: false,
  },
  {
    key: "content_drafting",
    name: "Content drafting",
    description:
      "Draft a public asset using only approved claims, with brand voice and prohibited wording attached.",
    version: "packet-content-v1",
    requiredCategories: ["identity", "market", "specialty", "service", "neighborhood"],
    requiredInstructionTypes: [
      "brand_voice",
      "prohibited_claim",
      "content_quality",
      "confidentiality",
    ],
    excludedCategories: [],
    hotFiles: ["client-summary", "approved-claims"],
    defaultTokenBudget: 8_000,
    // A public asset must not restate a claim past its review window.
    minFreshness: "nearing_review",
    audience: "public",
    allowedPrivacy: PUBLIC_ONLY,
    prohibitedSourceTypes: ["crm_export", "email", "transcript"],
    requiresClaims: true,
    allowsRetrieval: true,
  },
  {
    key: "claim_verification",
    name: "Claim verification",
    description:
      "Judge a proposed claim against approved claims, its original evidence, and the freshness rules.",
    version: "packet-claim-verify-v1",
    requiredCategories: [],
    requiredInstructionTypes: ["evidence_policy", "approval_rule"],
    excludedCategories: [],
    hotFiles: [],
    defaultTokenBudget: 6_000,
    minFreshness: "unknown",
    audience: "internal",
    allowedPrivacy: INTERNAL,
    prohibitedSourceTypes: [],
    requiresClaims: false,
    allowsRetrieval: false,
  },
  {
    key: "executive_report",
    name: "Executive report",
    description:
      "Compose a client-facing report from computed metrics, completed actions and attribution outcomes.",
    version: "packet-exec-report-v1",
    requiredCategories: ["identity", "market"],
    requiredInstructionTypes: ["attribution_policy", "content_quality"],
    excludedCategories: [],
    hotFiles: ["client-summary", "recent-changes", "active-actions", "open-risks"],
    defaultTokenBudget: 10_000,
    minFreshness: "nearing_review",
    audience: "client",
    allowedPrivacy: CLIENT_FACING,
    // Raw CRM and email content is never an input to a client report.
    prohibitedSourceTypes: ["crm_export", "email"],
    requiresClaims: false,
    allowsRetrieval: true,
  },
  {
    key: "outreach",
    name: "Outreach",
    description:
      "Compose prospect outreach from publicly verifiable authority only. No client-confidential material.",
    version: "packet-outreach-v1",
    requiredCategories: ["identity", "market"],
    requiredInstructionTypes: ["prohibited_claim", "confidentiality"],
    excludedCategories: ["transaction", "sales_volume"],
    hotFiles: [],
    defaultTokenBudget: 4_000,
    minFreshness: "nearing_review",
    audience: "public",
    allowedPrivacy: PUBLIC_ONLY,
    prohibitedSourceTypes: ["crm_export", "email", "transaction_file", "questionnaire"],
    requiresClaims: false,
    allowsRetrieval: true,
  },
  {
    key: "meeting_preparation",
    name: "Meeting preparation",
    description:
      "Brief an operator before a client meeting: status, performance, open approvals, risks.",
    version: "packet-meeting-v1",
    requiredCategories: ["identity", "market", "specialty"],
    requiredInstructionTypes: ["confidentiality"],
    excludedCategories: [],
    hotFiles: [
      "client-summary",
      "current-priorities",
      "open-risks",
      "active-actions",
      "recent-changes",
    ],
    defaultTokenBudget: 9_000,
    minFreshness: "stale",
    audience: "internal",
    allowedPrivacy: INTERNAL,
    prohibitedSourceTypes: [],
    requiresClaims: false,
    allowsRetrieval: true,
  },
  {
    key: "action_prioritization",
    name: "Action prioritization",
    description:
      "Explain a ranking of candidate actions against gaps, competitor intensity and historical outcomes.",
    version: "packet-prioritization-v1",
    requiredCategories: ["market", "specialty"],
    requiredInstructionTypes: ["escalation_policy"],
    excludedCategories: [],
    hotFiles: ["current-priorities", "open-risks", "active-actions"],
    defaultTokenBudget: 8_000,
    minFreshness: "stale",
    audience: "internal",
    allowedPrivacy: INTERNAL,
    prohibitedSourceTypes: [],
    requiresClaims: false,
    allowsRetrieval: true,
  },
];

const BY_KEY = new Map(PACKET_TEMPLATES.map((t) => [t.key, t]));

export function getPacketTemplate(key: string): PacketTemplate | undefined {
  return BY_KEY.get(key);
}

export function listPacketTemplates(): PacketTemplate[] {
  return [...PACKET_TEMPLATES];
}

/** A permissive default for callers with no task-specific template. */
export const GENERIC_TEMPLATE: PacketTemplate = {
  key: "generic",
  name: "Generic",
  description: "Approved claims with no task-specific selection. Prefer a named template.",
  version: "packet-generic-v1",
  requiredCategories: [],
  requiredInstructionTypes: [],
  excludedCategories: [],
  hotFiles: [],
  defaultTokenBudget: DEFAULT_PACKET_TOKEN_BUDGET,
  minFreshness: "unknown",
  audience: "internal",
  allowedPrivacy: INTERNAL,
  prohibitedSourceTypes: [],
  requiresClaims: false,
  allowsRetrieval: false,
};

/**
 * Mirror the code registry into the database. Idempotent; safe at every boot,
 * exactly like `syncAgentRegistry()`.
 */
export async function syncPacketTemplates(): Promise<{ templates: number }> {
  for (const template of PACKET_TEMPLATES) {
    await sql`
      insert into context_packet_templates (
        key, name, description, version, required_categories,
        required_instruction_types, excluded_categories, default_token_budget,
        min_freshness, allowed_privacy, prohibited_source_types, requires_claims
      ) values (
        ${template.key}, ${template.name}, ${template.description}, ${template.version},
        ${template.requiredCategories}, ${template.requiredInstructionTypes},
        ${template.excludedCategories}, ${template.defaultTokenBudget},
        ${template.minFreshness}, ${template.allowedPrivacy},
        ${template.prohibitedSourceTypes}, ${template.requiresClaims}
      )
      on conflict (key) do update set
        name = excluded.name, description = excluded.description,
        version = excluded.version,
        required_categories = excluded.required_categories,
        required_instruction_types = excluded.required_instruction_types,
        excluded_categories = excluded.excluded_categories,
        default_token_budget = excluded.default_token_budget,
        min_freshness = excluded.min_freshness,
        allowed_privacy = excluded.allowed_privacy,
        prohibited_source_types = excluded.prohibited_source_types,
        requires_claims = excluded.requires_claims,
        updated_at = now()
    `;
  }
  return { templates: PACKET_TEMPLATES.length };
}
