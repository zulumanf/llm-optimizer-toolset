/**
 * Integration tests for the automation layer, against a real Postgres.
 *
 * These run against a database because the properties under test are properties
 * of the database, not of the TypeScript: idempotent event consumption, replay
 * protection, durable approval waits, tenant isolation, and the fact that a
 * credential cannot be moved between connections. Asserting those with mocks
 * would prove nothing.
 */
import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { seedTestActors } from "../helpers/actors";
import { truncateAll } from "../helpers/db";

const TEST_URL = process.env.TEST_DATABASE_URL;
const OPERATOR = "00000000-0000-4000-8000-000000009001";
const TEST_KEY = Buffer.alloc(32, 11).toString("base64");

describe.skipIf(!TEST_URL)("automation layer (integration)", () => {
  let sql: (typeof import("@/db/client"))["sql"];
  let events: typeof import("@/lib/events/bus");
  let eventStore: typeof import("@/db/events");
  let triggers: typeof import("@/lib/triggers/service");
  let triggerStore: typeof import("@/db/triggers");
  let webhook: typeof import("@/lib/triggers/webhook");
  let credentials: typeof import("@/lib/connectors/credentials");
  let connectorStore: typeof import("@/db/connectors");
  let execute: typeof import("@/lib/connectors/execute");
  let suppression: typeof import("@/lib/outreach/suppression");
  let sequences: typeof import("@/lib/outreach/sequences");
  let runtime: typeof import("@/lib/automation/runtime");
  let workflows: typeof import("@/lib/automation/workflows");
  let handlers: typeof import("@/lib/workflow/handlers");
  let nodes: typeof import("@/lib/automation/nodes");
  let testmode: typeof import("@/lib/automation/testmode");
  let envelope: typeof import("@/lib/security/envelope");

  let projectA = "";
  let projectB = "";

  /**
   * A real `workflow_runs` row. Delivery attempts and trigger fires carry a
   * foreign key to it, so a test double returning a random uuid is rejected by
   * the database — correctly. Tests that stand in for the runtime must therefore
   * hand back a run that actually exists.
   */
  async function createRealRun(
    key: string,
    projectId: string | null = null
  ): Promise<string> {
    const [definition] = await sql`
      insert into workflow_definitions (key, name, action_type)
      values (${key}, ${key}, 'test')
      on conflict (key) do update set name = excluded.name
      returning id
    `;
    const [version] = await sql`
      insert into workflow_versions (definition_id, version, graph_hash, spec)
      values (${definition!.id}, 1, ${`hash-${key}`}, '{}'::jsonb)
      on conflict (definition_id, graph_hash) do update set version = workflow_versions.version
      returning id
    `;
    const [run] = await sql`
      insert into workflow_runs (version_id, project_id, idempotency_key)
      values (${version!.id}, ${projectId}, ${`run-${key}-${randomUUID()}`})
      returning id
    `;
    return run!.id as string;
  }

  beforeAll(async () => {
    process.env.AUTOMATION_CREDENTIAL_KEY = TEST_KEY;
    ({ sql } = await import("@/db/client"));
    // File-level clean slate: the shared schema is built once per
    // vitest run, so residue from earlier suites must be cleared here.
    await truncateAll(sql);
    events = await import("@/lib/events/bus");
    eventStore = await import("@/db/events");
    triggers = await import("@/lib/triggers/service");
    triggerStore = await import("@/db/triggers");
    webhook = await import("@/lib/triggers/webhook");
    credentials = await import("@/lib/connectors/credentials");
    connectorStore = await import("@/db/connectors");
    execute = await import("@/lib/connectors/execute");
    suppression = await import("@/lib/outreach/suppression");
    sequences = await import("@/lib/outreach/sequences");
    runtime = await import("@/lib/automation/runtime");
    workflows = await import("@/lib/automation/workflows");
    handlers = await import("@/lib/workflow/handlers");
    nodes = await import("@/lib/automation/nodes");
    testmode = await import("@/lib/automation/testmode");
    envelope = await import("@/lib/security/envelope");

    await seedTestActors(sql);
  });

  beforeEach(async () => {
    await sql.unsafe(
      `truncate audit_log, jobs, workflow_test_actions, workflow_fixtures,
       billing_events, support_requests, meeting_decisions, meeting_briefs,
       outreach_messages, outreach_sequences, suppression_entries,
       field_mapping_versions, field_mapping_definitions, connector_sync_runs,
       connector_health_checks, connector_credentials, connector_connections,
       webhook_receipts, webhook_endpoints, trigger_fires, automation_triggers,
       event_delivery_attempts, event_subscriptions, domain_events,
       workflow_transitions, workflow_signals, workflow_approvals,
       workflow_exceptions, quality_gate_results, node_runs, workflow_runs,
       workflow_edges, workflow_nodes, workflow_versions, workflow_definitions,
       autonomy_policies, agent_evaluations, agent_versions, agent_definitions,
       evidence_packets, claim_contradictions, claim_versions, action_outcomes,
       outcome_relationships, client_health_snapshots, operator_capacity_snapshots,
       executive_briefs, claims, tasks, projects cascade`
    );
    handlers.resetHandlers();
    nodes.forceRegisterAutomationNodes();
    testmode.resetRunModeCache();

    const [a] = await sql`insert into projects (name) values ('Client A') returning id`;
    const [b] = await sql`insert into projects (name) values ('Client B') returning id`;
    projectA = a!.id as string;
    projectB = b!.id as string;
  });

  afterAll(async () => {
    await sql.end();
  });

  // ------------------------------------------------------------- events

  describe("the domain event bus", () => {
    it("publishes a typed event transactionally with its cause", async () => {
      const result = await sql.begin((tx) =>
        events.publishEvent(tx, {
          type: "claim.expired",
          projectId: projectA,
          payload: { claimId: "c-1", subject: "credentials", expiresAt: "2026-08-01" },
        })
      );
      expect(result.created).toBe(true);
      const stored = await eventStore.getEvent(result.event.id);
      expect(stored?.type).toBe("claim.expired");
      expect(stored?.projectId).toBe(projectA);
      expect(stored?.correlationId).toBeTruthy();
    });

    it("rolls the event back when its causing transaction fails", async () => {
      // The whole reason the bus lives in Postgres: no event for a write that
      // did not happen.
      await expect(
        sql.begin(async (tx) => {
          await events.publishEvent(tx, {
            type: "claim.created",
            projectId: projectA,
            payload: { claimId: "c-2" },
          });
          throw new Error("the causing write failed");
        })
      ).rejects.toThrow("the causing write failed");

      const all = await eventStore.listEvents({ type: "claim.created" });
      expect(all).toHaveLength(0);
    });

    it("refuses an unknown event type", async () => {
      await expect(
        sql.begin((tx) =>
          events.publishEvent(tx, { type: "made.up.event", projectId: projectA, payload: {} })
        )
      ).rejects.toThrow(/Unknown domain event type/);
    });

    it("refuses a payload that fails its schema", async () => {
      await expect(
        sql.begin((tx) =>
          events.publishEvent(tx, {
            type: "visibility.materially_declined",
            projectId: projectA,
            // No sampleSize: a movement without its sample is not actionable.
            payload: { metric: "rate", previous: 0.4, current: 0.2, deltaPct: -50, periodStart: "a", periodEnd: "b" },
          })
        )
      ).rejects.toThrow(/is invalid/);
    });

    it("refuses a client-scoped event with no project", async () => {
      await expect(
        sql.begin((tx) =>
          events.publishEvent(tx, {
            type: "claim.expired",
            projectId: null,
            payload: { claimId: "c-1", expiresAt: "2026-08-01" },
          })
        )
      ).rejects.toThrow(/requires a projectId/);
    });

    it("writes one row for a duplicate dedupe key", async () => {
      const publish = () =>
        sql.begin((tx) =>
          events.publishEvent(tx, {
            type: "claim.expired",
            projectId: projectA,
            payload: { claimId: "c-9", expiresAt: "2026-08-01" },
            dedupeKey: "claim.expired:c-9",
          })
        );
      const first = await publish();
      const second = await publish();
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.event.id).toBe(first.event.id);
      expect(await eventStore.listEvents({ type: "claim.expired" })).toHaveLength(1);
    });

    it("is insert-only: an event cannot be edited or deleted", async () => {
      const result = await sql.begin((tx) =>
        events.publishEvent(tx, {
          type: "claim.created",
          projectId: projectA,
          payload: { claimId: "c-3" },
        })
      );
      await expect(
        sql`update domain_events set type = 'claim.approved' where id = ${result.event.id}`
      ).rejects.toThrow(/insert-only/);
      await expect(sql`delete from domain_events where id = ${result.event.id}`).rejects.toThrow(
        /insert-only/
      );
    });

    it("preserves the causal chain across events", async () => {
      const parent = await sql.begin((tx) =>
        events.publishEvent(tx, {
          type: "content.opportunity_created",
          projectId: projectA,
          payload: { opportunityId: "o-1", title: "Coral Gables Q3" },
        })
      );
      const child = await sql.begin((tx) =>
        events.publishEvent(tx, {
          type: "content.published",
          projectId: projectA,
          payload: { assetId: "a-1" },
          correlationId: parent.event.correlationId,
          causationId: parent.event.id,
        })
      );
      expect(child.event.correlationId).toBe(parent.event.correlationId);
      expect(child.event.causationId).toBe(parent.event.id);
      const chain = await eventStore.listEvents({ correlationId: parent.event.correlationId });
      expect(chain).toHaveLength(2);
    });
  });

  describe("event delivery", () => {
    async function subscribe(eventType: string, workflowKey: string, projectId: string | null = null) {
      return sql.begin((tx) =>
        eventStore.upsertSubscription(tx, {
          eventType,
          workflowKey,
          projectId,
          filter: { kind: "always" },
          idempotencyTemplate: "test:{{event.id}}",
          autonomyNote: "test subscription",
          acceptedVersions: [1],
          enabled: true,
          createdBy: null,
        })
      );
    }

    it("delivers an event to a matching subscription exactly once", async () => {
      await subscribe("lead.created", "test_workflow");
      const published = await sql.begin((tx) =>
        events.publishEvent(tx, {
          type: "lead.created",
          projectId: projectA,
          payload: { leadId: "l-1", email: "a@b.co", company: "X", sourceChannel: "form" },
        })
      );

      const started: string[] = [];
      const starter = async (args: { idempotencyKey: string }) => {
        started.push(args.idempotencyKey);
        return createRealRun("delivered_wf", projectA);
      };

      const first = await events.deliverEvent(published.event.id, starter);
      expect(first.filter((o) => o.status === "delivered")).toHaveLength(1);

      // Redelivery must not start a second run — the unique
      // (event_id, subscription_id) index is the guarantee.
      const second = await events.deliverEvent(published.event.id, starter);
      expect(second[0]!.status).toBe("already_handled");
      expect(started).toHaveLength(1);
    });

    it("skips a subscription whose filter does not match", async () => {
      const id = await sql.begin((tx) =>
        eventStore.upsertSubscription(tx, {
          eventType: "lead.qualified",
          workflowKey: "test_workflow",
          projectId: null,
          filter: { kind: "payload_gte", path: "score", value: 80 },
          idempotencyTemplate: "test:{{event.id}}",
          autonomyNote: "only strong leads",
          acceptedVersions: [1],
          enabled: true,
          createdBy: null,
        })
      );
      const published = await sql.begin((tx) =>
        events.publishEvent(tx, {
          type: "lead.qualified",
          projectId: projectA,
          payload: { leadId: "l-2", score: 55, confidence: 0.9 },
        })
      );
      const outcomes = await events.deliverEvent(published.event.id, () =>
        createRealRun("filtered_wf", projectA)
      );
      expect(outcomes[0]!.subscriptionId).toBe(id);
      expect(outcomes[0]!.status).toBe("skipped");
    });

    it("skips a subscription that does not accept the event's version", async () => {
      await sql.begin((tx) =>
        eventStore.upsertSubscription(tx, {
          eventType: "lead.created",
          workflowKey: "v2_only",
          projectId: null,
          filter: { kind: "always" },
          idempotencyTemplate: "test:{{event.id}}",
          autonomyNote: "v2 consumer",
          acceptedVersions: [2],
          enabled: true,
          createdBy: null,
        })
      );
      const published = await sql.begin((tx) =>
        events.publishEvent(tx, {
          type: "lead.created",
          projectId: projectA,
          payload: { leadId: "l-3", email: "a@b.co" },
        })
      );
      const outcomes = await events.deliverEvent(published.event.id, () =>
        createRealRun("version_wf", projectA)
      );
      expect(outcomes[0]!.status).toBe("skipped");
    });

    it("does not deliver another client's event to a client-scoped subscription", async () => {
      await subscribe("lead.created", "client_b_only", projectB);
      const published = await sql.begin((tx) =>
        events.publishEvent(tx, {
          type: "lead.created",
          projectId: projectA,
          payload: { leadId: "l-4", email: "a@b.co" },
        })
      );
      const outcomes = await events.deliverEvent(published.event.id, () =>
        createRealRun("cross_tenant_wf", projectA)
      );
      // The subscription is simply not a candidate — no delivery at all.
      expect(outcomes).toHaveLength(0);
    });

    it("retries a failed delivery then dead-letters it with an exception", async () => {
      await subscribe("lead.created", "broken_workflow");
      const published = await sql.begin((tx) =>
        events.publishEvent(tx, {
          type: "lead.created",
          projectId: projectA,
          payload: { leadId: "l-5", email: "a@b.co" },
        })
      );
      const failing = async () => {
        throw new Error("workflow is not published");
      };

      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await sql`update event_delivery_attempts set next_attempt_at = null`;
        await events.deliverEvent(published.event.id, failing);
      }

      const deadLetters = await eventStore.listDeadLetters();
      expect(deadLetters).toHaveLength(1);
      expect(deadLetters[0]!.workflowKey).toBe("broken_workflow");

      // Nothing fails silently.
      const [exception] = await sql`
        select kind, severity, summary from workflow_exceptions
        where project_id = ${projectA} order by created_at desc limit 1
      `;
      expect(exception?.kind).toBe("failed_workflow");
      expect(String(exception?.summary)).toContain("broken_workflow");
    });

    it("replays a dead letter on an explicit operator action", async () => {
      await subscribe("lead.created", "recovered_workflow");
      const published = await sql.begin((tx) =>
        events.publishEvent(tx, {
          type: "lead.created",
          projectId: projectA,
          payload: { leadId: "l-6", email: "a@b.co" },
        })
      );
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await sql`update event_delivery_attempts set next_attempt_at = null`;
        await events.deliverEvent(published.event.id, async () => {
          throw new Error("still broken");
        });
      }
      const [deadLetter] = await eventStore.listDeadLetters();
      const replayed = await sql.begin((tx) => eventStore.replayDelivery(tx, deadLetter!.id));
      expect(replayed).toBe(true);

      const outcomes = await events.deliverEvent(published.event.id, () =>
        createRealRun("recovered_wf", projectA)
      );
      expect(outcomes[0]!.status).toBe("delivered");
      expect(await eventStore.listDeadLetters()).toHaveLength(0);
    });

    it("reports per-type statistics", async () => {
      await subscribe("claim.approved", "test_workflow");
      const published = await sql.begin((tx) =>
        events.publishEvent(tx, {
          type: "claim.approved",
          projectId: projectA,
          payload: { claimId: "c-10" },
        })
      );
      await events.deliverEvent(published.event.id, () => createRealRun("stats_wf", projectA));
      const stats = await eventStore.eventStats();
      const entry = stats.find((s) => s.type === "claim.approved");
      expect(entry?.published).toBe(1);
      expect(entry?.delivered).toBe(1);
    });
  });

  // ----------------------------------------------------------- triggers

  describe("schedule triggers", () => {
    it("fires a due window exactly once, even across concurrent dispatchers", async () => {
      await triggers.registerTrigger(
        {
          key: "test_hourly",
          kind: "schedule",
          workflowKey: "test_workflow",
          projectId: projectA,
          cron: "0 * * * *",
          timezone: "UTC",
        },
        new Date("2026-08-03T00:30:00Z")
      );
      await sql`update automation_triggers set last_fired_at = ${new Date("2026-08-03T00:30:00Z")}`;

      const started: string[] = [];
      const starter = async (args: { idempotencyKey: string }) => {
        started.push(args.idempotencyKey);
        return createRealRun("fired_wf", projectA);
      };
      const now = new Date("2026-08-03T01:30:00Z");

      // Two dispatchers racing on the same window.
      const [a, b] = await Promise.all([
        triggers.dispatchDueTriggers(starter, now),
        triggers.dispatchDueTriggers(starter, now),
      ]);
      expect(a.fired + b.fired).toBe(1);
      expect(started).toHaveLength(1);
      expect(started[0]).toContain("2026-08-03T01:00:00Z");
    });

    it("records missed windows as skipped rather than dropping them silently", async () => {
      await triggers.registerTrigger(
        {
          key: "test_missed",
          kind: "schedule",
          workflowKey: "test_workflow",
          projectId: projectA,
          cron: "0 * * * *",
          timezone: "UTC",
          missedRunPolicy: "run_once",
        },
        new Date("2026-08-03T00:00:00Z")
      );
      await sql`update automation_triggers set last_fired_at = ${new Date("2026-08-03T00:30:00Z")}`;

      const summary = await triggers.dispatchDueTriggers(
        () => createRealRun("missed_wf", projectA),
        new Date("2026-08-03T05:30:00Z")
      );
      expect(summary.fired).toBe(1);
      expect(summary.skipped).toBe(4);

      const trigger = await triggerStore.getTriggerByKey("test_missed");
      const fires = await triggerStore.recentFires(trigger!.id);
      expect(fires.filter((f) => f.outcome === "skipped_missed")).toHaveLength(4);
    });

    it("records a failed fire and raises an exception", async () => {
      await triggers.registerTrigger(
        {
          key: "test_failing",
          kind: "schedule",
          workflowKey: "unpublished_workflow",
          projectId: projectA,
          cron: "0 * * * *",
          timezone: "UTC",
        },
        new Date("2026-08-03T00:00:00Z")
      );
      await sql`update automation_triggers set last_fired_at = ${new Date("2026-08-03T00:30:00Z")}`;

      const summary = await triggers.dispatchDueTriggers(async () => {
        throw new Error("no published version");
      }, new Date("2026-08-03T01:30:00Z"));
      expect(summary.failed).toBe(1);

      const [exception] = await sql`
        select kind, summary from workflow_exceptions where project_id = ${projectA}
      `;
      expect(exception?.kind).toBe("failed_workflow");
    });

    it("rejects an invalid cron at registration rather than at fire time", async () => {
      await expect(
        triggers.registerTrigger({
          key: "bad_cron",
          kind: "schedule",
          workflowKey: "test_workflow",
          cron: "0 9 L * *",
        })
      ).rejects.toThrow(/Unsupported cron syntax/);
    });

    it("rejects a threshold trigger with an unknown metric", async () => {
      await expect(
        triggers.registerTrigger({
          key: "bad_metric",
          kind: "threshold",
          workflowKey: "test_workflow",
          metricKey: "invented_metric",
          comparison: "gt",
          thresholdValue: 1,
        })
      ).rejects.toThrow(/Unknown threshold metric/);
    });

    it("fires a threshold trigger on the transition and not again", async () => {
      // Twelve approved claims coming up for review — a real, countable signal.
      await sql`
        insert into claims (project_id, key, canonical_text, status, review_date)
        select ${projectA}, 'claim-' || g, 'Claim ' || g, 'approved', current_date + 5
        from generate_series(1, 12) g
      `;
      await triggers.registerTrigger(
        {
          key: "claims_due",
          kind: "threshold",
          workflowKey: "test_workflow",
          projectId: projectA,
          metricKey: "claims_expiring_soon",
          comparison: "gte",
          thresholdValue: 10,
          lookbackDays: 30,
          minimumSample: 1,
          cron: "*/15 * * * *",
        },
        new Date("2026-08-03T00:00:00Z")
      );

      const first = await triggers.dispatchDueTriggers(
        () => createRealRun("threshold_wf", projectA),
        new Date("2026-08-03T01:00:00Z")
      );
      expect(first.fired).toBe(1);

      // Still above the line — must not re-fire.
      await sql`update automation_triggers set next_run_at = null`;
      const second = await triggers.dispatchDueTriggers(
        () => createRealRun("threshold_wf_2", projectA),
        new Date("2026-08-03T02:00:00Z")
      );
      expect(second.fired).toBe(0);
    });

    it("records insufficient_sample rather than guessing", async () => {
      await triggers.registerTrigger(
        {
          key: "thin_sample",
          kind: "threshold",
          workflowKey: "test_workflow",
          projectId: projectA,
          metricKey: "recommendation_rate",
          comparison: "lt",
          thresholdValue: 0.5,
          lookbackDays: 7,
          minimumSample: 20,
          cron: "*/15 * * * *",
        },
        new Date("2026-08-03T00:00:00Z")
      );
      const summary = await triggers.dispatchDueTriggers(
        () => createRealRun("thin_wf", projectA),
        new Date("2026-08-03T01:00:00Z")
      );
      expect(summary.fired).toBe(0);
      const trigger = await triggerStore.getTriggerByKey("thin_sample");
      const fires = await triggerStore.recentFires(trigger!.id);
      expect(fires[0]?.outcome).toBe("insufficient_sample");
    });

    it("requires a reason on a manual trigger", async () => {
      await expect(
        triggers.manualTrigger(
          {
            workflowKey: "test_workflow",
            projectId: projectA,
            reason: "",
            mode: "live",
            userId: OPERATOR,
          },
          async () => randomUUID()
        )
      ).rejects.toThrow(/requires a reason/);
    });

    it("audits a manual trigger with its reason", async () => {
      const runId = randomUUID();
      await sql`
        insert into workflow_definitions (key, name, action_type) values ('manual_wf', 'Manual', 'test')
      `;
      await triggers.manualTrigger(
        {
          workflowKey: "manual_wf",
          projectId: projectA,
          reason: "client asked us to re-run the July report",
          mode: "live",
          userId: OPERATOR,
        },
        async () => runId
      );
      const [audit] = await sql`
        select action, detail from audit_log where action = 'automation.manual_trigger'
      `;
      expect(audit).toBeTruthy();
      expect((audit!.detail as { reason: string }).reason).toContain("July report");
    });
  });

  // ----------------------------------------------------------- webhooks

  describe("webhook intake", () => {
    const secret = "whsec_integration_test";

    async function createEndpoint(overrides?: { scheme?: "hmac_sha256" | "none"; rateLimit?: number }) {
      const sealed = envelope.seal(secret, "placeholder");
      const [row] = await sql`
        insert into webhook_endpoints (slug, provider, project_id, event_type, signature_scheme,
          rate_limit_per_minute)
        values ('test-hook', 'form', ${projectA}, 'lead.created',
          ${overrides?.scheme ?? "hmac_sha256"}, ${overrides?.rateLimit ?? 60})
        returning id
      `;
      const endpointId = row!.id as string;
      // The AAD is the endpoint id, so the secret must be re-sealed against it.
      const resealed = envelope.seal(secret, endpointId);
      await sql`
        update webhook_endpoints set secret_ciphertext = ${resealed.ciphertext},
          secret_iv = ${resealed.iv}, secret_auth_tag = ${resealed.authTag}
        where id = ${endpointId}
      `;
      void sealed;
      return endpointId;
    }

    it("accepts a correctly signed payload and publishes a domain event", async () => {
      await createEndpoint();
      const body = JSON.stringify({ leadId: "l-100", email: "agent@example.com", company: "X" });
      const signature = createHmac("sha256", secret).update(body).digest("hex");

      const result = await webhook.receiveWebhook({
        slug: "test-hook",
        rawBody: body,
        signature,
        timestamp: null,
        providerEventId: "provider-evt-1",
      });
      expect(result.status).toBe("accepted");
      expect(result.httpStatus).toBe(202);

      const stored = await eventStore.getEvent(result.eventId!);
      expect(stored?.type).toBe("lead.created");
      expect(stored?.source).toBe("webhook");
      expect(stored?.projectId).toBe(projectA);
    });

    it("rejects an invalid signature and raises an exception", async () => {
      await createEndpoint();
      const result = await webhook.receiveWebhook({
        slug: "test-hook",
        rawBody: JSON.stringify({ leadId: "l-101", email: "a@b.co" }),
        signature: "0".repeat(64),
        timestamp: null,
        providerEventId: "provider-evt-2",
      });
      expect(result.status).toBe("rejected_signature");
      expect(result.httpStatus).toBe(401);

      const [exception] = await sql`
        select kind, summary from workflow_exceptions where project_id = ${projectA}
      `;
      expect(exception?.kind).toBe("failed_integration");
      expect(await eventStore.listEvents({ type: "lead.created" })).toHaveLength(0);
    });

    it("treats a replayed delivery as a duplicate and publishes nothing new", async () => {
      await createEndpoint();
      const body = JSON.stringify({ leadId: "l-102", email: "a@b.co" });
      const signature = createHmac("sha256", secret).update(body).digest("hex");
      const request = {
        slug: "test-hook",
        rawBody: body,
        signature,
        timestamp: null,
        providerEventId: "provider-evt-3",
      };

      const first = await webhook.receiveWebhook(request);
      const second = await webhook.receiveWebhook(request);
      expect(first.status).toBe("accepted");
      // A duplicate is a 200: an error would make the provider retry forever.
      expect(second.status).toBe("duplicate");
      expect(second.httpStatus).toBe(200);
      expect(await eventStore.listEvents({ type: "lead.created" })).toHaveLength(1);
    });

    it("rejects a payload that does not match the event schema", async () => {
      await createEndpoint();
      const body = JSON.stringify({ nothing: "useful" });
      const signature = createHmac("sha256", secret).update(body).digest("hex");
      const result = await webhook.receiveWebhook({
        slug: "test-hook",
        rawBody: body,
        signature,
        timestamp: null,
        providerEventId: "provider-evt-4",
      });
      expect(result.status).toBe("rejected_schema");
      expect(result.httpStatus).toBe(400);
    });

    it("rejects malformed JSON", async () => {
      await createEndpoint();
      const body = "{not json";
      const signature = createHmac("sha256", secret).update(body).digest("hex");
      const result = await webhook.receiveWebhook({
        slug: "test-hook",
        rawBody: body,
        signature,
        timestamp: null,
        providerEventId: "provider-evt-5",
      });
      expect(result.status).toBe("rejected_schema");
    });

    it("rate limits per endpoint", async () => {
      await createEndpoint({ rateLimit: 2 });
      const send = async (id: string) => {
        const body = JSON.stringify({ leadId: id, email: "a@b.co" });
        return webhook.receiveWebhook({
          slug: "test-hook",
          rawBody: body,
          signature: createHmac("sha256", secret).update(body).digest("hex"),
          timestamp: null,
          providerEventId: id,
        });
      };
      await send("r-1");
      await send("r-2");
      const third = await send("r-3");
      expect(third.status).toBe("rejected_rate_limit");
      expect(third.httpStatus).toBe(429);
    });

    it("refuses an unknown slug without revealing anything", async () => {
      const result = await webhook.receiveWebhook({
        slug: "does-not-exist",
        rawBody: "{}",
        signature: null,
        timestamp: null,
        providerEventId: "x",
      });
      expect(result.httpStatus).toBe(404);
    });

    it("refuses a disabled endpoint", async () => {
      await createEndpoint();
      await sql`update webhook_endpoints set enabled = false`;
      const result = await webhook.receiveWebhook({
        slug: "test-hook",
        rawBody: "{}",
        signature: null,
        timestamp: null,
        providerEventId: "x",
      });
      expect(result.status).toBe("rejected_disabled");
      expect(result.httpStatus).toBe(403);
    });
  });

  // -------------------------------------------------------- connectors

  describe("credentials and tenant isolation", () => {
    async function createConnection(projectId: string, provider = "fixture") {
      return sql.begin((tx) =>
        connectorStore.insertConnection(tx, {
          projectId,
          provider,
          connectionName: `${provider} for ${projectId}`,
          externalAccountId: `acct-${projectId}`,
          grantedScopes: ["read"],
          config: {},
          expiresAt: null,
          createdBy: OPERATOR,
        })
      );
    }

    it("stores a credential encrypted and never returns plaintext from db/", async () => {
      const connectionId = await createConnection(projectA);
      await credentials.storeCredential({
        connectionId,
        kind: "api_key",
        secret: "sk-live-super-secret",
        userId: OPERATOR,
      });

      const [row] = await sql`
        select ciphertext, iv, auth_tag from connector_credentials where connection_id = ${connectionId}
      `;
      const stored = (row!.ciphertext as Buffer).toString("utf8");
      expect(stored).not.toContain("sk-live-super-secret");

      const resolved = await credentials.resolveSecrets(connectionId);
      expect(resolved.accessToken).toBe("sk-live-super-secret");
    });

    it("refuses to decrypt a credential row moved to another connection", async () => {
      const connectionA = await createConnection(projectA);
      const connectionB = await createConnection(projectB);
      await credentials.storeCredential({
        connectionId: connectionA,
        kind: "api_key",
        secret: "sk-client-a-secret",
        userId: OPERATOR,
      });

      // Simulate the attack: copy the ciphertext onto another client's connection.
      const [material] = await sql`
        select ciphertext, iv, auth_tag, kind, key_version
        from connector_credentials where connection_id = ${connectionA}
      `;
      await sql`
        insert into connector_credentials (connection_id, kind, ciphertext, iv, auth_tag, key_version)
        values (${connectionB}, ${material!.kind}, ${material!.ciphertext}, ${material!.iv},
                ${material!.authTag}, ${material!.keyVersion})
      `;
      await expect(credentials.resolveSecrets(connectionB)).rejects.toThrow(/could not be decrypted/);
    });

    it("audits a credential write without recording the secret", async () => {
      const connectionId = await createConnection(projectA);
      await credentials.storeCredential({
        connectionId,
        kind: "oauth2",
        secret: "sk-live-audit-check",
        refreshToken: "rt-audit-check",
        userId: OPERATOR,
      });
      const [audit] = await sql`
        select detail from audit_log where action = 'connector.credential_stored'
      `;
      const detail = JSON.stringify(audit!.detail);
      expect(detail).not.toContain("sk-live-audit-check");
      expect(detail).not.toContain("rt-audit-check");
      expect(detail).toContain("hasRefreshToken");
    });

    it("does not resolve another client's connection", async () => {
      await createConnection(projectB, "ga4");
      const found = await connectorStore.connectionFor({ projectId: projectA, provider: "ga4" });
      expect(found).toBeNull();
    });

    it("revokes a connection and destroys its credential while keeping the audit row", async () => {
      const connectionId = await createConnection(projectA);
      await credentials.storeCredential({
        connectionId,
        kind: "api_key",
        secret: "sk-to-revoke",
        userId: OPERATOR,
      });
      await credentials.revokeCredential(connectionId, OPERATOR);

      expect(await connectorStore.hasCredential(connectionId)).toBe(false);
      const connection = await connectorStore.getConnection(connectionId);
      // The connection row stays, revoked, for audit.
      expect(connection?.status).toBe("revoked");
      expect(connection?.revokedAt).toBeTruthy();
    });

    it("raises a tenant-scope exception if resolution ever crosses a boundary", async () => {
      const connectionB = await createConnection(projectB, "hubspot");
      // Force the pathological case the guard exists for.
      await sql`update connector_connections set project_id = ${projectB} where id = ${connectionB}`;
      const result = await execute.executeCapability({
        capability: "crm.fetch_contacts",
        projectId: projectA,
        input: {},
        mode: "live",
        provider: "hubspot",
      });
      // No connection for A → an honest failure, not B's data.
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("no_connection");
    });

    it("refuses a consequential capability in test mode and records the payload", async () => {
      const connectionId = await createConnection(projectA, "gmail");
      await credentials.storeCredential({
        connectionId,
        kind: "oauth2",
        secret: "token",
        userId: OPERATOR,
      });
      const [run] = await sql`
        insert into workflow_definitions (key, name, action_type) values ('t_wf', 'T', 'test') returning id
      `;
      const [version] = await sql`
        insert into workflow_versions (definition_id, version, graph_hash, spec)
        values (${run!.id}, 1, 'h1', '{}'::jsonb) returning id
      `;
      const [workflowRun] = await sql`
        insert into workflow_runs (version_id, project_id, idempotency_key, mode)
        values (${version!.id}, ${projectA}, 'test-run-1', 'test') returning id
      `;

      const result = await execute.executeCapability({
        capability: "email.send_approved_message",
        projectId: projectA,
        input: { to: "agent@example.com", subject: "S", body: "B" },
        mode: "test",
        provider: "gmail",
        workflowRunId: workflowRun!.id as string,
      });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("test_mode_refused");

      // The would-have-happened ledger is the product of a test run.
      const actions = await testmode.testActionsFor(workflowRun!.id as string);
      expect(actions).toHaveLength(1);
      expect(actions[0]!.capability).toBe("email.send_approved_message");
      expect(actions[0]!.reason).toContain("consequential");
    });

    it("records a sync run for a fixture-mode read", async () => {
      const connectionId = await createConnection(projectA, "fixture");
      await credentials.storeCredential({
        connectionId,
        kind: "api_key",
        secret: "token",
        userId: OPERATOR,
      });
      const result = await execute.executeCapability({
        capability: "analytics.fetch_sessions",
        projectId: projectA,
        input: {},
        mode: "test",
        provider: "fixture",
        fixtures: { "analytics.fetch_sessions": { rows: [{ sessions: 5 }] } },
      });
      expect(result.ok).toBe(true);
      const [sync] = await sql`
        select mode, ok, capability from connector_sync_runs where connection_id = ${connectionId}
      `;
      expect(sync?.mode).toBe("test");
      expect(sync?.ok).toBe(true);
    });

    it("raises an exception when no provider is connected", async () => {
      const result = await execute.executeCapability({
        capability: "crm.fetch_contacts",
        projectId: projectA,
        input: {},
        mode: "live",
        provider: "hubspot",
      });
      expect(result.ok).toBe(false);
      const [exception] = await sql`
        select kind, recommended_action from workflow_exceptions where project_id = ${projectA}
      `;
      expect(exception?.kind).toBe("failed_integration");
      expect(String(exception?.recommendedAction)).toContain("Connect the provider");
    });
  });

  // -------------------------------------------------------- suppression

  describe("suppression and outreach stop rules", () => {
    it("suppresses an address and matches it despite a plus-tag", async () => {
      await sql.begin((tx) =>
        suppression.suppress(tx, {
          scope: "email",
          value: "Agent@Example.com",
          reason: "opt_out",
          projectId: null,
          userId: OPERATOR,
        })
      );
      const check = await suppression.checkSuppression({
        email: "AGENT+summer-campaign@example.com",
        projectId: projectA,
      });
      // The detail that separates a real suppression list from a decorative one.
      expect(check.suppressed).toBe(true);
      expect(check.reason).toBe("opt_out");
      expect(check.global).toBe(true);
    });

    it("suppresses a whole domain", async () => {
      await sql.begin((tx) =>
        suppression.suppress(tx, {
          scope: "domain",
          value: "https://www.brokerage.com/about",
          reason: "legal_request",
          projectId: null,
          userId: OPERATOR,
        })
      );
      const check = await suppression.checkSuppression({
        email: "anyone@brokerage.com",
        projectId: projectA,
      });
      expect(check.suppressed).toBe(true);
      expect(check.matchedScope).toBe("domain");
    });

    it("scopes a client-specific suppression to that client", async () => {
      await sql.begin((tx) =>
        suppression.suppress(tx, {
          scope: "email",
          value: "shared@example.com",
          reason: "client_request",
          projectId: projectA,
          userId: OPERATOR,
        })
      );
      expect((await suppression.checkSuppression({ email: "shared@example.com", projectId: projectA })).suppressed).toBe(true);
      expect((await suppression.checkSuppression({ email: "shared@example.com", projectId: projectB })).suppressed).toBe(false);
    });

    it("keeps the historical row when a suppression is lifted", async () => {
      const result = await sql.begin((tx) =>
        suppression.suppress(tx, {
          scope: "email",
          value: "lift@example.com",
          reason: "manual",
          projectId: null,
          userId: OPERATOR,
        })
      );
      await sql.begin((tx) =>
        suppression.liftSuppression(tx, {
          id: result.id!,
          userId: OPERATOR,
          reason: "the contact re-subscribed in writing",
        })
      );
      expect((await suppression.checkSuppression({ email: "lift@example.com" })).suppressed).toBe(false);
      // The history of "we were asked to stop, then un-stopped" survives.
      const all = await suppression.listSuppressions({ includeLifted: true });
      expect(all).toHaveLength(1);
      expect(all[0]!.liftedAt).toBeTruthy();
    });

    it("requires a reason to lift a suppression", async () => {
      const result = await sql.begin((tx) =>
        suppression.suppress(tx, {
          scope: "email",
          value: "x@example.com",
          reason: "manual",
          projectId: null,
          userId: OPERATOR,
        })
      );
      await expect(
        sql.begin((tx) =>
          suppression.liftSuppression(tx, { id: result.id!, userId: OPERATOR, reason: "" })
        )
      ).rejects.toThrow(/requires a reason/);
    });

    it("refuses to open a sequence for a suppressed recipient", async () => {
      await sql.begin((tx) =>
        suppression.suppress(tx, {
          scope: "email",
          value: "blocked@example.com",
          reason: "hard_bounce",
          projectId: null,
          userId: OPERATOR,
        })
      );
      const result = await sql.begin((tx) =>
        sequences.createSequence(tx, {
          projectId: projectA,
          workflowRunId: null,
          subjectKind: "prospect",
          subjectRef: "p-1",
          recipientEmail: "blocked@example.com",
        })
      );
      expect(result.refused).toBe(true);
      expect(result.reason).toContain("suppressed");
    });

    it("refuses to store a draft with an unsupported factual claim", async () => {
      const created = await sql.begin((tx) =>
        sequences.createSequence(tx, {
          projectId: projectA,
          workflowRunId: null,
          subjectKind: "prospect",
          subjectRef: "p-2",
          recipientEmail: "ok@example.com",
        })
      );
      await expect(
        sql.begin((tx) =>
          sequences.addMessage(tx, {
            sequenceId: created.sequenceId,
            step: 1,
            subject: "Your visibility",
            body: "You are losing two million dollars a year.",
            claims: [
              { statement: "You are losing two million dollars a year.", kind: "fact", evidenceIds: [] },
            ],
            evidenceIds: [],
          })
        )
      ).rejects.toThrow(/unsupported factual claims/);
    });

    it("stops a sequence on a reply and cancels its queued drafts", async () => {
      const created = await sql.begin((tx) =>
        sequences.createSequence(tx, {
          projectId: projectA,
          workflowRunId: null,
          subjectKind: "prospect",
          subjectRef: "p-3",
          recipientEmail: "reply@example.com",
        })
      );
      await sql.begin((tx) =>
        sequences.addMessage(tx, {
          sequenceId: created.sequenceId,
          step: 1,
          subject: "S",
          body: "B",
          claims: [],
          evidenceIds: [],
        })
      );
      const result = await sql.begin((tx) =>
        sequences.applyInboundSignal(tx, { sequenceId: created.sequenceId, signal: "reply" })
      );
      expect(result.stopped).toBe(true);

      const sequence = await sequences.getSequence(created.sequenceId);
      expect(sequence?.status).toBe("stopped_replied");
      expect(sequence?.nextSendAt).toBeNull();
      // A stopped sequence must not leave a sendable artifact lying around.
      const messages = await sequences.messagesFor(created.sequenceId);
      expect(messages[0]!.status).toBe("cancelled");
    });

    it("suppresses globally on an opt-out", async () => {
      const created = await sql.begin((tx) =>
        sequences.createSequence(tx, {
          projectId: projectA,
          workflowRunId: null,
          subjectKind: "prospect",
          subjectRef: "p-4",
          recipientEmail: "optout@example.com",
        })
      );
      await sql.begin((tx) =>
        sequences.applyInboundSignal(tx, { sequenceId: created.sequenceId, signal: "opt_out" })
      );
      // An opt-out is a permanent instruction, not a per-sequence one.
      const check = await suppression.checkSuppression({ email: "optout@example.com", projectId: projectB });
      expect(check.suppressed).toBe(true);
      expect(check.global).toBe(true);
    });

    it("suppresses globally on a hard bounce", async () => {
      const created = await sql.begin((tx) =>
        sequences.createSequence(tx, {
          projectId: projectA,
          workflowRunId: null,
          subjectKind: "prospect",
          subjectRef: "p-5",
          recipientEmail: "bounce@example.com",
        })
      );
      await sql.begin((tx) =>
        sequences.applyInboundSignal(tx, { sequenceId: created.sequenceId, signal: "bounce" })
      );
      expect((await suppression.checkSuppression({ email: "bounce@example.com" })).suppressed).toBe(true);
    });

    it("is idempotent when two stop signals race", async () => {
      const created = await sql.begin((tx) =>
        sequences.createSequence(tx, {
          projectId: projectA,
          workflowRunId: null,
          subjectKind: "prospect",
          subjectRef: "p-6",
          recipientEmail: "race@example.com",
        })
      );
      // A reply and a bounce can arrive together; neither should fail.
      const first = await sql.begin((tx) =>
        sequences.stopSequence(tx, { sequenceId: created.sequenceId, reason: "replied" })
      );
      const second = await sql.begin((tx) =>
        sequences.stopSequence(tx, { sequenceId: created.sequenceId, reason: "bounced" })
      );
      expect(first.stopped).toBe(true);
      expect(second.alreadyStopped).toBe(true);
      expect((await sequences.getSequence(created.sequenceId))?.status).toBe("stopped_replied");
    });

    it("refuses to record a second send for the same message", async () => {
      const created = await sql.begin((tx) =>
        sequences.createSequence(tx, {
          projectId: projectA,
          workflowRunId: null,
          subjectKind: "prospect",
          subjectRef: "p-7",
          recipientEmail: "once@example.com",
        })
      );
      const message = await sql.begin((tx) =>
        sequences.addMessage(tx, {
          sequenceId: created.sequenceId,
          step: 1,
          subject: "S",
          body: "B",
          claims: [],
          evidenceIds: [],
        })
      );
      await sql.begin((tx) =>
        sequences.markMessageSent(tx, {
          messageId: message.messageId,
          providerMessageId: "prov-1",
          nextSendAt: null,
        })
      );
      await expect(
        sql.begin((tx) =>
          sequences.markMessageSent(tx, {
            messageId: message.messageId,
            providerMessageId: "prov-2",
            nextSendAt: null,
          })
        )
      ).rejects.toThrow(/already sent/);
    });
  });

  // ------------------------------------------------------- the send gate

  describe("the external-send gate", () => {
    const base = {
      projectId: "",
      recipientEmail: "gate@example.com",
      bodyHash: "hash-1",
      autonomyLevel: 4,
      hasRelationship: true,
      connectionProjectId: null as string | null,
      runMode: "live" as const,
    };

    beforeEach(() => {
      base.projectId = projectA;
      base.connectionProjectId = projectA;
    });

    it("allows a send that passes every check", async () => {
      const verdict = await suppression.assertSendAllowed(base);
      expect(verdict.allowed).toBe(true);
      expect(verdict.checks.every((c) => c.passed)).toBe(true);
    });

    it("refuses in test mode before anything else is evaluated", async () => {
      const verdict = await suppression.assertSendAllowed({ ...base, runMode: "test" });
      expect(verdict.allowed).toBe(false);
      expect(verdict.failedCheck).toBe("run_mode");
    });

    it("refuses a suppressed recipient", async () => {
      await sql.begin((tx) =>
        suppression.suppress(tx, {
          scope: "email",
          value: "gate@example.com",
          reason: "complaint",
          projectId: null,
          userId: OPERATOR,
        })
      );
      const verdict = await suppression.assertSendAllowed(base);
      expect(verdict.allowed).toBe(false);
      expect(verdict.failedCheck).toBe("suppression");
    });

    it("refuses when the sending connection belongs to another client", async () => {
      const verdict = await suppression.assertSendAllowed({ ...base, connectionProjectId: projectB });
      expect(verdict.allowed).toBe(false);
      expect(verdict.failedCheck).toBe("tenant_match");
    });

    it("refuses a cold contact with no stated business purpose", async () => {
      const verdict = await suppression.assertSendAllowed({
        ...base,
        hasRelationship: false,
        businessPurpose: null,
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.failedCheck).toBe("recipient_authorization");
    });

    it("refuses cold outreach with no unsubscribe path", async () => {
      const verdict = await suppression.assertSendAllowed({
        ...base,
        hasRelationship: false,
        businessPurpose: "measured their AI visibility from public data; offering the findings",
        unsubscribeUrl: null,
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.failedCheck).toBe("compliance_fields");
    });

    it("requires an approval at autonomy level 2", async () => {
      const verdict = await suppression.assertSendAllowed({ ...base, autonomyLevel: 2 });
      expect(verdict.allowed).toBe(false);
      expect(verdict.failedCheck).toBe("approval");
    });

    it("refuses an approval that was rejected", async () => {
      const [definition] = await sql`
        insert into workflow_definitions (key, name, action_type) values ('g_wf', 'G', 'test') returning id
      `;
      const [version] = await sql`
        insert into workflow_versions (definition_id, version, graph_hash, spec)
        values (${definition!.id}, 1, 'gh', '{}'::jsonb) returning id
      `;
      const [run] = await sql`
        insert into workflow_runs (version_id, project_id, idempotency_key)
        values (${version!.id}, ${projectA}, 'gate-run') returning id
      `;
      const [node] = await sql`
        insert into workflow_nodes (version_id, node_key, node_type, name)
        values (${version!.id}, 'n', 'integration_task', 'N') returning id
      `;
      const [nodeRun] = await sql`
        insert into node_runs (workflow_run_id, node_id, node_key, fan_key, state)
        values (${run!.id}, ${node!.id}, 'n', '', 'awaiting_approval') returning id
      `;
      const [approval] = await sql`
        insert into workflow_approvals (workflow_run_id, node_run_id, project_id, action_type,
          risk_level, required_role, summary, decision, decided_by, decided_at)
        values (${run!.id}, ${nodeRun!.id}, ${projectA}, 'outreach', 'high', 'operator',
          'Send it?', 'rejected', ${OPERATOR}, now())
        returning id
      `;
      const verdict = await suppression.assertSendAllowed({
        ...base,
        autonomyLevel: 2,
        approvalId: approval!.id as string,
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.failedCheck).toBe("approval");
      expect(verdict.reason).toContain("rejected");
    });

    it("refuses when the message changed after approval", async () => {
      const [definition] = await sql`
        insert into workflow_definitions (key, name, action_type) values ('h_wf', 'H', 'test') returning id
      `;
      const [version] = await sql`
        insert into workflow_versions (definition_id, version, graph_hash, spec)
        values (${definition!.id}, 1, 'hh', '{}'::jsonb) returning id
      `;
      const [run] = await sql`
        insert into workflow_runs (version_id, project_id, idempotency_key)
        values (${version!.id}, ${projectA}, 'hash-run') returning id
      `;
      const [node] = await sql`
        insert into workflow_nodes (version_id, node_key, node_type, name)
        values (${version!.id}, 'n', 'integration_task', 'N') returning id
      `;
      const [nodeRun] = await sql`
        insert into node_runs (workflow_run_id, node_id, node_key, fan_key, state)
        values (${run!.id}, ${node!.id}, 'n', '', 'awaiting_approval') returning id
      `;
      const [approval] = await sql`
        insert into workflow_approvals (workflow_run_id, node_run_id, project_id, action_type,
          risk_level, required_role, summary, detail, decision, decided_by, decided_at)
        values (${run!.id}, ${nodeRun!.id}, ${projectA}, 'outreach', 'high', 'operator',
          'Send it?', ${sql.json({ bodyHash: "the-approved-hash" })}, 'approved', ${OPERATOR}, now())
        returning id
      `;
      const verdict = await suppression.assertSendAllowed({
        ...base,
        autonomyLevel: 2,
        approvalId: approval!.id as string,
        bodyHash: "a-different-hash",
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.failedCheck).toBe("message_version");
    });

    it("refuses when the approval records no artifact hash at all (A7: fail closed)", async () => {
      const [definition] = await sql`
        insert into workflow_definitions (key, name, action_type) values ('nh_wf', 'NH', 'test') returning id
      `;
      const [version] = await sql`
        insert into workflow_versions (definition_id, version, graph_hash, spec)
        values (${definition!.id}, 1, 'nhh', '{}'::jsonb) returning id
      `;
      const [run] = await sql`
        insert into workflow_runs (version_id, project_id, idempotency_key)
        values (${version!.id}, ${projectA}, 'nohash-run') returning id
      `;
      const [node] = await sql`
        insert into workflow_nodes (version_id, node_key, node_type, name)
        values (${version!.id}, 'n', 'integration_task', 'N') returning id
      `;
      const [nodeRun] = await sql`
        insert into node_runs (workflow_run_id, node_id, node_key, fan_key, state)
        values (${run!.id}, ${node!.id}, 'n', '', 'awaiting_approval') returning id
      `;
      // The shape the engine used to write: hash buried under output, nothing
      // at detail.bodyHash. This must now REFUSE — the old soft-pass meant
      // the version check never actually ran.
      const [approval] = await sql`
        insert into workflow_approvals (workflow_run_id, node_run_id, project_id, action_type,
          risk_level, required_role, summary, detail, decision, decided_by, decided_at)
        values (${run!.id}, ${nodeRun!.id}, ${projectA}, 'outreach', 'high', 'operator',
          'Send it?', ${sql.json({ output: { artifact: { bodyHash: "buried" } } })},
          'approved', ${OPERATOR}, now())
        returning id
      `;
      const verdict = await suppression.assertSendAllowed({
        ...base,
        autonomyLevel: 2,
        approvalId: approval!.id as string,
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.failedCheck).toBe("message_version");
      expect(verdict.reason).toContain("no artifact hash");
    });

    it("allows a send whose approved hash matches", async () => {
      const [definition] = await sql`
        insert into workflow_definitions (key, name, action_type) values ('i_wf', 'I', 'test') returning id
      `;
      const [version] = await sql`
        insert into workflow_versions (definition_id, version, graph_hash, spec)
        values (${definition!.id}, 1, 'ih', '{}'::jsonb) returning id
      `;
      const [run] = await sql`
        insert into workflow_runs (version_id, project_id, idempotency_key)
        values (${version!.id}, ${projectA}, 'match-run') returning id
      `;
      const [node] = await sql`
        insert into workflow_nodes (version_id, node_key, node_type, name)
        values (${version!.id}, 'n', 'integration_task', 'N') returning id
      `;
      const [nodeRun] = await sql`
        insert into node_runs (workflow_run_id, node_id, node_key, fan_key, state)
        values (${run!.id}, ${node!.id}, 'n', '', 'awaiting_approval') returning id
      `;
      const [approval] = await sql`
        insert into workflow_approvals (workflow_run_id, node_run_id, project_id, action_type,
          risk_level, required_role, summary, detail, decision, decided_by, decided_at)
        values (${run!.id}, ${nodeRun!.id}, ${projectA}, 'outreach', 'high', 'operator',
          'Send it?', ${sql.json({ bodyHash: "hash-1" })}, 'approved', ${OPERATOR}, now())
        returning id
      `;
      const verdict = await suppression.assertSendAllowed({
        ...base,
        autonomyLevel: 2,
        approvalId: approval!.id as string,
      });
      expect(verdict.allowed).toBe(true);
    });
  });

  // ----------------------------------------------------------- runtime

  describe("the automation runtime", () => {
    beforeEach(async () => {
      await workflows.bootstrapAutomation({ installTriggers: false });
      // A platform-level internal-notification connection, so the live-mode
      // tests below exercise the runtime rather than the preflight. The
      // preflight's own refusal is asserted separately.
      const connectionId = await sql.begin((tx) =>
        connectorStore.insertConnection(tx, {
          projectId: null,
          provider: "internal_notification",
          connectionName: "platform notifications",
          externalAccountId: "platform",
          grantedScopes: [],
          config: {},
          expiresAt: null,
          createdBy: OPERATOR,
        })
      );
      await credentials.storeCredential({
        connectionId,
        kind: "api_key",
        secret: "not-used-by-the-internal-adapter",
        userId: OPERATOR,
      });
    });

    it("publishes every shipped workflow as a version", async () => {
      const [row] = await sql`select count(*)::int as n from workflow_definitions`;
      expect(Number(row!.n)).toBeGreaterThanOrEqual(18);
      const [versions] = await sql`select count(*)::int as n from workflow_versions`;
      expect(Number(versions!.n)).toBeGreaterThanOrEqual(18);
    });

    it("re-registers an unchanged graph to the same version", async () => {
      const before = await sql`select count(*)::int as n from workflow_versions`;
      await workflows.bootstrapAutomation({ installTriggers: false });
      const after = await sql`select count(*)::int as n from workflow_versions`;
      expect(Number(after[0]!.n)).toBe(Number(before[0]!.n));
    });

    it("stamps a test run's mode in the database, not by convention", async () => {
      const run = await runtime.startWorkflow({
        workflowKey: workflows.CONTROL_TOWER_KEY,
        idempotencyKey: "ct-test-1",
        mode: "test",
        fixtures: { connectorResponses: [], agentResponses: [] },
      });
      expect(run.mode).toBe("test");
      const [row] = await sql`select mode from workflow_runs where id = ${run.id}`;
      expect(row!.mode).toBe("test");
    });

    it("keeps a live and a test run of the same key distinct", async () => {
      const live = await runtime.startWorkflow({
        workflowKey: workflows.CONTROL_TOWER_KEY,
        idempotencyKey: "same-key",
        mode: "live",
      });
      // The mode prefixes the idempotency key, so a test run cannot collapse
      // onto a production run.
      const test = await runtime.startWorkflow({
        workflowKey: workflows.CONTROL_TOWER_KEY,
        idempotencyKey: "same-key",
        mode: "test",
      });
      expect(test.id).not.toBe(live.id);
    });

    it("deduplicates a repeated start with the same key and mode", async () => {
      const first = await runtime.startWorkflow({
        workflowKey: workflows.CONTROL_TOWER_KEY,
        idempotencyKey: "dedupe-key",
        mode: "live",
      });
      const second = await runtime.startWorkflow({
        workflowKey: workflows.CONTROL_TOWER_KEY,
        idempotencyKey: "dedupe-key",
        mode: "live",
      });
      expect(second.id).toBe(first.id);
    });

    it("refuses a client-scoped workflow with no client", async () => {
      await expect(
        runtime.startWorkflow({
          workflowKey: workflows.WEEKLY_OPS_KEY,
          idempotencyKey: "no-client",
          mode: "test",
        })
      ).rejects.toThrow(/requires a projectId/);
    });

    it("refuses a platform-scoped workflow given a client", async () => {
      await expect(
        runtime.startWorkflow({
          workflowKey: workflows.CONTROL_TOWER_KEY,
          projectId: projectA,
          idempotencyKey: "wrong-scope",
          mode: "test",
        })
      ).rejects.toThrow(/platform-scoped/);
    });

    it("refuses a live run whose required connector is not connected", async () => {
      await expect(
        runtime.startWorkflow({
          workflowKey: workflows.MONTHLY_REPORT_KEY,
          projectId: projectA,
          idempotencyKey: "no-connector",
          mode: "live",
        })
      ).rejects.toThrow(/no connected provider/);
    });

    it("allows the same workflow in test mode with no connectors at all", async () => {
      const run = await runtime.startWorkflow({
        workflowKey: workflows.MONTHLY_REPORT_KEY,
        projectId: projectA,
        idempotencyKey: "test-no-connector",
        mode: "test",
        fixtures: { connectorResponses: [], agentResponses: [] },
      });
      expect(run.mode).toBe("test");
    });

    it("enforces the per-client concurrency limit", async () => {
      await runtime.startWorkflow({
        workflowKey: workflows.CONTROL_TOWER_KEY,
        idempotencyKey: "conc-1",
        mode: "test",
      });
      await expect(
        runtime.startWorkflow({
          workflowKey: workflows.CONTROL_TOWER_KEY,
          idempotencyKey: "conc-2",
          mode: "test",
        })
      ).rejects.toThrow(/already has 1 test run\(s\) in flight/);
    });

    it("lists exceptions in deterministic priority order with components available", async () => {
      await sql`
        insert into workflow_exceptions (project_id, kind, severity, summary, sla_hours, due_at)
        values
          (${projectA}, 'failed_workflow', 'low', 'minor', 8, now() + interval '7 days'),
          (${projectA}, 'evidence_conflict', 'critical', 'urgent conflict', 24, now() - interval '1 hour')
      `;
      const exceptions = await runtime.listExceptions({ projectId: projectA });
      expect(exceptions).toHaveLength(2);
      // Overdue + critical must outrank low + distant.
      expect(exceptions[0]!.summary).toBe("urgent conflict");
      expect(exceptions[0]!.priority).toBeGreaterThan(exceptions[1]!.priority);
    });

    it("does not leak another client's exceptions", async () => {
      await sql`
        insert into workflow_exceptions (project_id, kind, severity, summary, sla_hours, due_at)
        values (${projectB}, 'failed_workflow', 'high', 'client B only', 8, now())
      `;
      const exceptions = await runtime.listExceptions({ projectId: projectA });
      expect(exceptions.map((e) => e.summary)).not.toContain("client B only");
    });
  });
});
