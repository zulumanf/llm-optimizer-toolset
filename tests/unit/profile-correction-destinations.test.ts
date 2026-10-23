/**
 * Spec 147 slice 3 — pure destination validation, routing targets and the
 * external-submission approval binding.
 */
import { describe, expect, it } from "vitest";
import { destinationInputSchema } from "@/lib/profile-corrections/destinations";
import { routableDestinationSchema, routingTarget } from "@/lib/profile-corrections/routing";
import { externalApprovalBindingError } from "@/lib/profile-corrections/approval-binding";
import { profileCorrectionRequestHash } from "@/lib/profile-corrections/request";
import {
  OPEN_CORRECTION_STATUSES,
  REROUTABLE_CORRECTION_STATUSES,
  WITHDRAWABLE_CORRECTION_STATUSES,
  profileExternalApprovalKey,
  PROFILE_EXTERNAL_APPROVAL_TEMPLATE,
} from "@/lib/profile-corrections/constants";
import { renderIdempotencyKey } from "@/lib/events/filter";
import { eventDefinition } from "@/lib/events/catalog";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const DEST = "d0000000-0000-4000-8000-000000000001";
const OTHER_DEST = "d0000000-0000-4000-8000-000000000002";
const URL_ = "https://www.zillow.com/profile/ana";

const editor = {
  projectId: PROJECT,
  profileUrl: URL_,
  kind: "client_editor",
  recipientName: "Maria Perez",
  email: "Maria@PerezRealty.example",
  basis: "Client confirmed Maria edits the Zillow profile.",
};
const publisher = {
  ...editor,
  kind: "publisher",
  recipientName: "Corrections desk",
  email: "corrections@ratings.example.org",
  sourceUrl: "https://ratings.example.org/corrections",
};

describe("destinationInputSchema", () => {
  it("accepts a client_editor and a publisher destination", () => {
    const e = destinationInputSchema.parse(editor);
    expect(e.email).toBe("maria@perezrealty.example");
    expect(destinationInputSchema.parse(publisher).sourceUrl).toBe(publisher.sourceUrl);
  });

  it("requires a source URL for a publisher", () => {
    expect(destinationInputSchema.safeParse({ ...publisher, sourceUrl: undefined }).success).toBe(false);
    expect(destinationInputSchema.safeParse({ ...publisher, sourceUrl: null }).success).toBe(false);
    expect(destinationInputSchema.safeParse({ ...publisher, sourceUrl: "ftp://x.example/y" }).success).toBe(false);
  });

  it.each(["maria", "maria@", "@perezrealty.example", "maria perez@x.example", ""])(
    "rejects the malformed email %s",
    (email) => {
      expect(destinationInputSchema.safeParse({ ...editor, email }).success).toBe(false);
    }
  );

  it("rejects an unknown kind, a non-http profile, a blank basis and extra keys", () => {
    expect(destinationInputSchema.safeParse({ ...editor, kind: "platform" }).success).toBe(false);
    expect(destinationInputSchema.safeParse({ ...editor, profileUrl: "mailto:x@y.z" }).success).toBe(false);
    expect(destinationInputSchema.safeParse({ ...editor, basis: " " }).success).toBe(false);
    expect(destinationInputSchema.safeParse({ ...editor, inferredFrom: "domain" }).success).toBe(false);
  });
});

describe("routingTarget", () => {
  it("no destination → destination_required, nothing published", () => {
    expect(routingTarget(null)).toEqual({ status: "destination_required", destinationId: null, publishExternalApproval: false });
  });
  it("client_editor → ready_to_draft", () => {
    expect(routingTarget({ id: DEST, kind: "client_editor" })).toEqual({
      status: "ready_to_draft",
      destinationId: DEST,
      publishExternalApproval: false,
    });
  });
  it("publisher → awaiting_external_approval and the authorization event", () => {
    expect(routingTarget({ id: DEST, kind: "publisher" })).toEqual({
      status: "awaiting_external_approval",
      destinationId: DEST,
      publishExternalApproval: true,
    });
  });
});

describe("routableDestinationSchema", () => {
  const row = {
    id: DEST,
    kind: "publisher",
    recipientName: "Desk",
    email: "desk@ratings.example.org",
    basis: "Corrections page",
    sourceUrl: "https://ratings.example.org/corrections",
    archivedAt: null,
  };
  it("accepts an active, well-formed destination", () => {
    expect(routableDestinationSchema.safeParse(row).success).toBe(true);
  });
  it("refuses an archived, malformed or sourceless publisher destination", () => {
    expect(routableDestinationSchema.safeParse({ ...row, archivedAt: new Date() }).success).toBe(false);
    expect(routableDestinationSchema.safeParse({ ...row, email: "desk" }).success).toBe(false);
    expect(routableDestinationSchema.safeParse({ ...row, sourceUrl: null }).success).toBe(false);
  });
});

describe("externalApprovalBindingError", () => {
  const request = { version: "profile-correction-request-v1", items: [{ approvedClaimId: "x" }] };
  const sha = profileCorrectionRequestHash(request);
  const detail = (destinationId: string, req: unknown = request, shown = sha) => ({
    output: { artifact: { request: req, requestSha256: shown, destination: { id: destinationId } } },
  });

  it("binds to the request hash and the exact destination shown", () => {
    expect(externalApprovalBindingError(detail(DEST), sha, DEST)).toBeNull();
  });
  it("refuses another destination, an edited request, or a missing destination", () => {
    expect(externalApprovalBindingError(detail(OTHER_DEST), sha, DEST)).toMatch(/routed to/);
    expect(externalApprovalBindingError(detail(DEST, { ...request, items: [] }), sha, DEST)).toMatch(/hash/);
    expect(externalApprovalBindingError({ output: { artifact: { request, requestSha256: sha } } }, sha, DEST)).toMatch(
      /does not name the destination/
    );
  });
});

describe("status sets and continuation identity", () => {
  it("treats the publisher wait as open, withdrawable and re-routable", () => {
    for (const set of [OPEN_CORRECTION_STATUSES, WITHDRAWABLE_CORRECTION_STATUSES, REROUTABLE_CORRECTION_STATUSES]) {
      expect(set as readonly string[]).toContain("awaiting_external_approval");
    }
    expect(REROUTABLE_CORRECTION_STATUSES as readonly string[]).not.toContain("approved");
    expect(REROUTABLE_CORRECTION_STATUSES as readonly string[]).not.toContain("sent");
  });

  it("keys one authorization run per (request, destination)", () => {
    const payload = { correctionRequestId: PROJECT, destinationId: DEST };
    expect(
      renderIdempotencyKey(PROFILE_EXTERNAL_APPROVAL_TEMPLATE, {
        id: "e",
        type: "profile.external_approval_required",
        projectId: PROJECT,
        payload,
      })
    ).toBe(profileExternalApprovalKey(PROJECT, DEST));
    const schema = eventDefinition("profile.external_approval_required")!.schema;
    expect(schema.safeParse(payload).success).toBe(true);
    expect(schema.safeParse({ correctionRequestId: PROJECT }).success).toBe(false);
  });
});
