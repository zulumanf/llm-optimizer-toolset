/**
 * Integration tests for spec 032 Phase 2.2/2.3 — prospect contacts and CSV
 * import: contact CRUD with one-primary and per-prospect email uniqueness;
 * import persisting through the same createProspect/addContact paths with
 * provenance labels; and the outreach recipient gates (account DNC →
 * contact DNC → global suppression on normalised contact identifiers).
 */
import { execSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CurrentUser } from "@/lib/auth";
import { seedTestActors } from "../helpers/actors";
import { unwrap } from "../helpers/result";

const TEST_URL = process.env.TEST_DATABASE_URL;
const ROOT = join(__dirname, "..", "..");

const operator: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000401",
  email: "op@test.local",
  name: "Operator",
  role: "operator",
};
const admin: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000001",
  email: "admin@test.local",
  name: "Admin",
  role: "admin",
};
const clientViewer: CurrentUser = {
  id: "00000000-0000-4000-8000-000000000002",
  email: "client@test.local",
  name: "Client",
  role: "client_viewer",
};

describe.skipIf(!TEST_URL)("prospect contacts and import (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let projectSvc: typeof import("@/lib/projects/service");
  let setSvc: typeof import("@/lib/prompts/set-service");
  let promptSvc: typeof import("@/lib/prompts/prompt-service");
  let runSvc: typeof import("@/lib/runs/service");
  let execute: typeof import("@/lib/runs/execute");
  let jobs: typeof import("@/db/jobs");
  let companySvc: typeof import("@/lib/companies/service");
  let claims: typeof import("@/lib/claims/service");
  let parsing: typeof import("@/lib/parsing/service");
  let scoring: typeof import("@/lib/scoring/compute");
  let exclusivity: typeof import("@/lib/exclusivity/service");
  let svc: typeof import("@/lib/prospects/service");
  let suppression: typeof import("@/lib/outreach/suppression");
  let mock: typeof import("@/lib/ai/mock");

  beforeAll(async () => {
    ({ sql } = await import("@/db/client"));
    projectSvc = await import("@/lib/projects/service");
    setSvc = await import("@/lib/prompts/set-service");
    promptSvc = await import("@/lib/prompts/prompt-service");
    runSvc = await import("@/lib/runs/service");
    execute = await import("@/lib/runs/execute");
    jobs = await import("@/db/jobs");
    companySvc = await import("@/lib/companies/service");
    claims = await import("@/lib/claims/service");
    parsing = await import("@/lib/parsing/service");
    scoring = await import("@/lib/scoring/compute");
    exclusivity = await import("@/lib/exclusivity/service");
    svc = await import("@/lib/prospects/service");
    suppression = await import("@/lib/outreach/suppression");
    mock = await import("@/lib/ai/mock");
    await sql.unsafe("drop schema public cascade; create schema public;");
    execSync(`npx tsx scripts/migrate.ts up --db "${TEST_URL}"`, {
      cwd: ROOT,
      stdio: "pipe",
    });
    await seedTestActors(sql);
    await sql`update users set role = 'client_viewer' where id = ${clientViewer.id}`;
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, suppression_entries,
       prospect_activities, prospect_stage_history, screen_recording_plans,
       outreach_drafts, prospect_contacts, prospect_audit_views, prospect_audits,
       prospect_findings, prospect_benchmarks, prospect_authority_signals,
       prospects, market_launches,
       exclusivity_checks, exclusivity_scopes, exclusivity_agreements, markets,
       claims, competitors, scores, sources, response_parses, mentions,
       response_citations, brand_candidates, companies, responses, runs,
       prompt_set_versions, prompts, prompt_sets, projects cascade`
    );
    mock.resetMockProvider();
  });

  afterAll(async () => {
    await sql.end();
  });

  async function drainJobs(): Promise<void> {
    for (let i = 0; i < 200; i += 1) {
      const job = await jobs.claimNextJob("test-worker");
      if (!job) return;
      if (job.type === "execute_run") await execute.executeRun(job.payload.runId as string);
      else if (job.type === "parse_response")
        await parsing.parseResponse(job.payload.responseId as string);
      else if (job.type === "compute_scores")
        await scoring.computeScores(job.payload.runId as string);
      await jobs.completeJob(job.id);
    }
  }


  async function seedLaunch(marketName = "Manhattan"): Promise<{ launchId: string }> {
    const market = unwrap(
      await exclusivity.createMarket(admin, { name: marketName, kind: "borough", aliases: [] })
    );
    const launch = unwrap(
      await svc.createLaunch(operator, {
        name: `${marketName} luxury residential`,
        marketId: market.marketId,
        priceSegment: "luxury",
      })
    );
    return { launchId: launch.launchId };
  }

  async function seedProspect(launchId: string, name = "Rivera Team"): Promise<string> {
    const prospect = unwrap(
      await svc.createProspect(operator, { launchId, businessName: name, prospectType: "team" })
    );
    return prospect.prospectId;
  }

  /** Scored run + prospect wired to a company + approved primary finding —
   *  the full prerequisite chain for an outreach draft. */
  async function seedDraftReadyProspect(): Promise<{ prospectId: string }> {
    const subject = unwrap(await companySvc.upsertCompany(operator, { name: "Lumina" }));
    unwrap(await companySvc.upsertCompany(operator, { name: "Acme" }));
    const rivera = unwrap(await companySvc.upsertCompany(operator, { name: "Rivera Team" }));
    const project = unwrap(await projectSvc.createProject(operator, { name: "Client A" }));
    unwrap(
      await claims.setSubjectCompany(operator, { projectId: project.id, companyId: subject.id })
    );
    const set = unwrap(
      await setSvc.createPromptSet(operator, { projectId: project.id, name: "Set" })
    );
    for (const text of [
      "best luxury team in manhattan?",
      "which team should sell my tribeca loft?",
    ]) {
      unwrap(
        await promptSvc.addPrompt(operator, { setId: set.id, text, category: "recommendation" })
      );
    }
    unwrap(await setSvc.freezePromptSet(operator, { id: set.id }));
    const [version] = await sql`
      select id from prompt_set_versions where prompt_set_id = ${set.id}
    `;
    const run = unwrap(
      await runSvc.startRun(operator, {
        projectId: project.id,
        promptSetVersionId: version?.id as string,
        providers: [{ provider: "mock", model: "mock-model", repetitions: 3 }],
        budgetUsd: 5,
        label: "prospect benchmark run",
      })
    );
    await drainJobs();

    const { launchId } = await seedLaunch();
    const prospect = unwrap(
      await svc.createProspect(operator, {
        launchId,
        businessName: "Rivera Team",
        prospectType: "team",
        companyId: rivera.id,
        teamLeader: "Ana Rivera",
      })
    );
    const { benchmarkId } = unwrap(
      await svc.linkBenchmark(operator, { prospectId: prospect.prospectId, runId: run.id })
    );
    unwrap(await svc.generateFindings(operator, { benchmarkId }));
    const [candidate] = await sql`
      select id from prospect_findings
      where prospect_id = ${prospect.prospectId} and status = 'candidate'
      order by rank_score desc limit 1
    `;
    unwrap(
      await svc.reviewFinding(operator, {
        findingId: candidate?.id as string,
        decision: "approved",
        makePrimary: true,
      })
    );
    return { prospectId: prospect.prospectId };
  }

  it("contact CRUD: one primary, unique email per prospect, archive frees both", async () => {
    const { launchId } = await seedLaunch();
    const prospectId = await seedProspect(launchId);

    const first = unwrap(
      await svc.addContact(operator, {
        prospectId,
        name: "Ana Rivera",
        role: "Team leader",
        email: "ana@riverateam.com",
        isPrimary: true,
        provenance: "publicly_sourced",
      })
    );
    // Second primary demotes the first instead of failing
    const second = unwrap(
      await svc.addContact(operator, {
        prospectId,
        name: "Ben Ortiz",
        email: "ben@riverateam.com",
        isPrimary: true,
      })
    );
    const primaries = await sql`
      select id from prospect_contacts
      where prospect_id = ${prospectId} and is_primary and archived_at is null
    `;
    expect(primaries.length).toBe(1);
    expect(primaries[0]?.id).toBe(second.contactId);

    // Same email on the same prospect is a conflict, case-insensitively
    const dup = await svc.addContact(operator, {
      prospectId,
      name: "Ana again",
      email: "ANA@riverateam.com",
    });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error.kind).toBe("conflict");
    // …but fine on a different prospect
    const otherId = await seedProspect(launchId, "Other Team");
    unwrap(await svc.addContact(operator, { prospectId: otherId, name: "Ana", email: "ana@riverateam.com" }));

    // Archive frees the email and the primary slot
    unwrap(await svc.archiveContact(operator, { contactId: first.contactId }));
    unwrap(
      await svc.addContact(operator, { prospectId, name: "Ana back", email: "ana@riverateam.com" })
    );

    // An archived contact cannot be updated
    const updateArchived = await svc.updateContact(operator, {
      contactId: first.contactId,
      role: "ghost",
    });
    expect(updateArchived.ok).toBe(false);

    // Client roles are denied
    const denied = await svc.addContact(clientViewer, { prospectId, name: "Nope" });
    expect(denied.ok).toBe(false);

    // Timeline recorded the contact work
    const kinds = (
      await sql`select kind from prospect_activities where prospect_id = ${prospectId}`
    ).map((a) => a.kind);
    expect(kinds).toContain("contact_added");
    expect(kinds).toContain("contact_archived");
  });

  it("CSV import persists rows with provenance labels, contacts, dedup, and per-row errors", async () => {
    const { launchId } = await seedLaunch();
    // Pre-existing prospect → the matching row counts as a duplicate
    await seedProspect(launchId, "Rivera Team");

    const csv = [
      "business_name,type,team_leader,brokerage,website,email,contact_name,contact_email",
      "Rivera Team,team,Ana Rivera,Compass,riverateam.com,hello@riverateam.com,Ana Rivera,ana@riverateam.com",
      "Ortiz Group,team,Ben Ortiz,Corcoran,ortizgroup.com,,Ben Ortiz,ben@ortizgroup.com",
      "Weird Type,dirigible,,,,,,",
      "Solo Agent,agent,,,soloagent.nyc,solo@soloagent.nyc,,",
    ].join("\n");

    const report = unwrap(
      await svc.importProspects(operator, {
        launchId,
        csv,
        provenance: "publicly_sourced",
        sourceUrl: "https://therealdeal.com/rankings",
      })
    );
    expect(report.created).toBe(2); // Ortiz Group + Solo Agent
    expect(report.duplicates).toBe(1); // Rivera Team
    expect(report.errors.length).toBe(1); // dirigible
    expect(report.errors[0]?.line).toBe(4);

    // Facts carry the provenance label and source='csv'
    const [ortiz] = await sql`
      select prospect_type, source, field_provenance, website, team_leader
      from prospects where launch_id = ${launchId} and business_name = 'Ortiz Group'
    `;
    expect(ortiz?.source).toBe("csv");
    expect(ortiz?.website).toBe("https://ortizgroup.com");
    expect((ortiz?.fieldProvenance as Record<string, string>).website).toBe("publicly_sourced");
    expect((ortiz?.fieldProvenance as Record<string, string>).teamLeader).toBe("publicly_sourced");

    // "agent" alias maps to individual_agent
    const [solo] = await sql`
      select prospect_type from prospects
      where launch_id = ${launchId} and business_name = 'Solo Agent'
    `;
    expect(solo?.prospectType).toBe("individual_agent");

    // Contact rows created as primary, with the file's provenance
    const [contact] = await sql`
      select c.name, c.email, c.is_primary, c.provenance
      from prospect_contacts c join prospects p on p.id = c.prospect_id
      where p.business_name = 'Ortiz Group'
    `;
    expect(contact).toMatchObject({
      name: "Ben Ortiz",
      email: "ben@ortizgroup.com",
      isPrimary: true,
      provenance: "publicly_sourced",
    });

    // The import itself is audited with counts and the source URL
    const [auditRow] = await sql`
      select detail from audit_log where action = 'prospect.import'
      order by at desc limit 1
    `;
    expect(auditRow?.detail).toMatchObject({
      created: 2,
      duplicates: 1,
      sourceUrl: "https://therealdeal.com/rankings",
    });
  });

  it("outreach gates: contact DNC and suppression on contact identifiers block approval and record-sent", async () => {
    const { prospectId } = await seedDraftReadyProspect();
    const contact = unwrap(
      await svc.addContact(operator, {
        prospectId,
        name: "Ana Rivera",
        email: "Ana.Rivera@riverateam.com",
        isPrimary: true,
      })
    );

    // Draft addressed to a contact of a DIFFERENT prospect is refused
    const { launchId: otherLaunchId } = await seedLaunch("Brooklyn");
    const strangerId = await seedProspect(otherLaunchId, "Stranger Team");
    const strangerContactId = unwrap(
      await svc.addContact(operator, { prospectId: strangerId, name: "Someone Else" })
    ).contactId;
    const cross = await svc.createOutreachDraft(operator, {
      prospectId,
      channel: "email",
      contactId: strangerContactId,
    });
    expect(cross.ok).toBe(false);

    // Draft to our contact: created, then blocked by contact-level DNC
    const draft = unwrap(
      await svc.createOutreachDraft(operator, {
        prospectId,
        channel: "email",
        contactId: contact.contactId,
      })
    );
    unwrap(
      await svc.updateContact(operator, {
        contactId: contact.contactId,
        doNotContact: true,
        doNotContactReason: "asked us to stop",
      })
    );
    const blocked = await svc.approveOutreachDraft(operator, { draftId: draft.draftId });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.message).toContain("do-not-contact");

    // Lift DNC → approval passes → suppression entry blocks record-sent,
    // matching the plus-tagged variant of the contact's email (normalised).
    unwrap(await svc.updateContact(operator, { contactId: contact.contactId, doNotContact: false }));
    unwrap(await svc.approveOutreachDraft(operator, { draftId: draft.draftId }));
    await sql.begin(async (tx) => {
      await suppression.suppress(tx, {
        scope: "email",
        value: "ana.rivera+campaign@riverateam.com",
        reason: "opt_out",
        userId: operator.id,
      });
    });
    const suppressed = await svc.recordDraftSent(operator, { draftId: draft.draftId });
    expect(suppressed.ok).toBe(false);
    if (!suppressed.ok) expect(suppressed.error.message).toContain("suppression");

    // Lifting the suppression unblocks the send record
    const [entry] = await sql`select id from suppression_entries where lifted_at is null`;
    await sql.begin(async (tx) => {
      await suppression.liftSuppression(tx, {
        id: entry?.id as string,
        userId: admin.id,
        reason: "operator error, contact re-consented",
      });
    });
    unwrap(await svc.recordDraftSent(operator, { draftId: draft.draftId }));

    // Archiving the contact makes a NEW draft to them impossible
    unwrap(await svc.archiveContact(operator, { contactId: contact.contactId }));
    const toArchived = await svc.createOutreachDraft(operator, {
      prospectId,
      channel: "linkedin_message",
      contactId: contact.contactId,
    });
    expect(toArchived.ok).toBe(false);
  });
});
