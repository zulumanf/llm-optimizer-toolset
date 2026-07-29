/**
 * The five adapters that need no external provider — and are therefore the
 * only ones this repository can honestly label `verified`.
 *
 *  - `fixture`      — canned responses for every capability. Test mode and the
 *                     E2E demos run on this.
 *  - `csv`          — operator-supplied CSV as an ingestion source. The
 *                     fallback when a client cannot grant API access.
 *  - `manual`       — an operator types the payload. Slow, but real, and it
 *                     keeps a workflow unblocked.
 *  - `internal_notification` — writes to the platform's own notifications
 *                     table (spec: docs/17 B2), so internal alerts need no
 *                     third party at all.
 *  - `local_file_store` — artifact storage on the local filesystem under a
 *                     scoped directory.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { sql } from "@/db/client";
import { CONNECTOR_CAPABILITIES, executionFailure } from "@/lib/connectors/types";
import type { CapabilityHandler } from "@/lib/connectors/adapters/base";
import { buildAdapter, abortWith, requireString } from "@/lib/connectors/adapters/base";
import type { ConnectorCapability } from "@/lib/connectors/types";

// ------------------------------------------------------------------ fixture

/**
 * Every capability, served from the run's fixture bundle. `buildAdapter`
 * intercepts fixture mode before these handlers run; they exist so the fixture
 * connector also works when a connection is deliberately configured in "live"
 * mode against canned data (which is what a replayable demo needs).
 */
const fixtureHandlers: Partial<Record<ConnectorCapability, CapabilityHandler>> = {};
for (const capability of CONNECTOR_CAPABILITIES) {
  fixtureHandlers[capability] = async (_input, ctx) => {
    const canned = ctx.fixtures[capability];
    if (canned === undefined) {
      abortWith(
        executionFailure({
          error: `Fixture connector has no canned response for "${capability}".`,
          errorCode: "fixture_missing",
          retryable: false,
        })
      );
    }
    return { data: canned, rowsRead: Array.isArray(canned) ? canned.length : 1 };
  };
}

export const fixtureConnector = buildAdapter({
  id: "fixture",
  provider: "fixture",
  version: "1.0.0",
  category: "testing",
  status: "verified",
  configSchema: z.object({}).passthrough(),
  handlers: fixtureHandlers,
  probe: async () => ({
    authorizationOk: true,
    readOk: true,
    latencyMs: 0,
    errorCode: null,
    errorMessage: null,
  }),
});

// ---------------------------------------------------------------------- csv

const csvConfig = z.object({
  /** Column header → canonical field. Applied before the platform sees a row. */
  headerMap: z.record(z.string()).default({}),
  delimiter: z.string().length(1).default(","),
});

/**
 * Parse a delimited document. Handles quoted fields and embedded delimiters,
 * because a CSV of real estate addresses is full of commas and a naive split
 * silently corrupts them.
 */
export function parseDelimited(text: string, delimiter = ","): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...body] = rows.filter((r) => r.some((cell) => cell.trim().length > 0));
  if (!header) return [];
  return body.map((cells) => {
    const record: Record<string, string> = {};
    header.forEach((name, position) => {
      record[name.trim()] = (cells[position] ?? "").trim();
    });
    return record;
  });
}

const csvRead: CapabilityHandler = async (input, ctx) => {
  const text = requireString(input, "csv", "csv ingestion");
  const config = csvConfig.parse(ctx.config);
  const rows = parseDelimited(text, config.delimiter);
  const mapped = rows.map((row) => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(row)) {
      out[config.headerMap[key] ?? key] = value;
    }
    return out;
  });
  return { data: { rows: mapped, sourceRowCount: rows.length }, rowsRead: mapped.length };
};

export const csvConnector = buildAdapter({
  id: "csv",
  provider: "csv",
  version: "1.0.0",
  category: "ingestion",
  status: "verified",
  configSchema: csvConfig,
  handlers: {
    "crm.fetch_contacts": csvRead,
    "crm.fetch_opportunities": csvRead,
    "crm.fetch_stage_history": csvRead,
    "analytics.fetch_sessions": csvRead,
    "analytics.fetch_events": csvRead,
    "analytics.fetch_landing_pages": csvRead,
    "analytics.fetch_referrals": csvRead,
    "search_console.fetch_queries": csvRead,
    "search_console.fetch_pages": csvRead,
  },
  probe: async () => ({
    authorizationOk: true,
    readOk: true,
    latencyMs: 0,
    errorCode: null,
    errorMessage: null,
  }),
});

// ------------------------------------------------------------------- manual

/**
 * An operator supplies the payload. Deliberately available for read
 * capabilities only: "a human typed what the CRM says" is a legitimate input,
 * whereas "a human typed that the email was sent" is not something the
 * platform should record as a send.
 */
const manualRead: CapabilityHandler = async (input) => {
  const payload = input.payload;
  if (payload === undefined) {
    abortWith(
      executionFailure({
        error: 'Manual connector requires a "payload".',
        errorCode: "invalid_input",
        retryable: false,
      })
    );
  }
  return {
    data: { payload, enteredManually: true },
    rowsRead: Array.isArray(payload) ? payload.length : 1,
  };
};

export const manualConnector = buildAdapter({
  id: "manual",
  provider: "manual",
  version: "1.0.0",
  category: "ingestion",
  status: "verified",
  configSchema: z.object({ enteredBy: z.string().optional() }),
  handlers: {
    "crm.fetch_contacts": manualRead,
    "crm.fetch_opportunities": manualRead,
    "crm.fetch_stage_history": manualRead,
    "analytics.fetch_sessions": manualRead,
    "analytics.fetch_events": manualRead,
    "analytics.fetch_landing_pages": manualRead,
    "analytics.fetch_referrals": manualRead,
    "search_console.fetch_queries": manualRead,
    "search_console.fetch_pages": manualRead,
    "cms.fetch_public_page": manualRead,
    "billing.fetch_payment_status": manualRead,
  },
  probe: async () => ({
    authorizationOk: true,
    readOk: true,
    latencyMs: 0,
    errorCode: null,
    errorMessage: null,
  }),
});

// ---------------------------------------------------- internal notification

const notificationConfig = z.object({
  defaultSeverity: z.enum(["urgent", "attention", "info"]).default("info"),
});

const NOTIFICATION_SEVERITIES = ["urgent", "attention", "info"] as const;

/**
 * Writes to the platform's own notifications table (spec 015). This is why
 * "notify the operator" needs no third-party dependency and can honestly be
 * labelled `verified`.
 *
 * `dedupe_key` is unique on that table by design: one row per ongoing issue,
 * not one per scan. A workflow that alerts on every tick therefore updates its
 * row rather than burying the operator.
 */
const sendInternal: CapabilityHandler = async (input, ctx) => {
  const title = requireString(input, "title", "notification.send_internal");
  const body = typeof input.body === "string" ? input.body : "";
  const config = notificationConfig.parse(ctx.config);
  const requested = typeof input.severity === "string" ? input.severity : config.defaultSeverity;
  const severity = (NOTIFICATION_SEVERITIES as readonly string[]).includes(requested)
    ? requested
    : config.defaultSeverity;
  const kind = String(input.kind ?? "automation");
  // Caller-supplied key when it has a natural one; otherwise the run, so a
  // re-tick of the same run does not stack duplicates.
  const dedupeKey =
    typeof input.dedupeKey === "string" && input.dedupeKey.length > 0
      ? input.dedupeKey
      : `automation:${kind}:${ctx.workflowRunId ?? title}`;

  const [row] = await sql`
    insert into notifications (project_id, kind, severity, title, body, href, dedupe_key)
    values (
      ${ctx.projectId}, ${kind}, ${severity}, ${title}, ${body},
      ${typeof input.href === "string" ? input.href : null}, ${dedupeKey}
    )
    on conflict (dedupe_key) do update set
      severity = excluded.severity,
      title = excluded.title,
      body = excluded.body,
      last_seen_at = now(),
      status = case when notifications.status = 'dismissed'
                    then notifications.status else 'unread' end
    returning id
  `;
  return {
    data: { notificationId: (row?.id as string) ?? null, delivered: true, dedupeKey },
    rowsWritten: 1,
  };
};

export const internalNotificationConnector = buildAdapter({
  id: "internal_notification",
  provider: "internal_notification",
  version: "1.0.0",
  category: "notification",
  status: "verified",
  configSchema: notificationConfig,
  handlers: { "notification.send_internal": sendInternal },
  probe: async () => {
    const started = Date.now();
    await sql`select 1`;
    return {
      authorizationOk: true,
      readOk: true,
      latencyMs: Date.now() - started,
      errorCode: null,
      errorMessage: null,
    };
  },
});

// --------------------------------------------------------- local file store

const fileStoreConfig = z.object({
  /** Root directory for artifacts. Relative paths resolve under `var/`. */
  root: z.string().default("var/artifacts"),
});

/**
 * Path containment. An artifact key that escapes the configured root is
 * refused — a stored artifact must never be able to overwrite source or config.
 */
function safeArtifactPath(root: string, key: string): string {
  if (key.length === 0) {
    abortWith(
      executionFailure({
        error: "An artifact key is required.",
        errorCode: "invalid_input",
        retryable: false,
      })
    );
  }
  const base = resolve(process.cwd(), root);
  const target = resolve(base, key);
  if (target !== base && !target.startsWith(base + "/")) {
    abortWith(
      executionFailure({
        error: "Artifact key escapes the configured storage root.",
        errorCode: "path_traversal_refused",
        retryable: false,
      })
    );
  }
  return target;
}

export const localFileStoreConnector = buildAdapter({
  id: "local_file_store",
  provider: "local_file_store",
  version: "1.0.0",
  category: "storage",
  status: "verified",
  configSchema: fileStoreConfig,
  handlers: {
    "file.store": async (input, ctx) => {
      const config = fileStoreConfig.parse(ctx.config);
      const key = requireString(input, "key", "file.store");
      const content = requireString(input, "content", "file.store");
      const path = safeArtifactPath(config.root, key);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, content, "utf8");
      // The hash is the artifact's identity: a report that cites an artifact
      // can prove the bytes have not changed since it cited them.
      const hash = createHash("sha256").update(content).digest("hex");
      return {
        data: { key, bytes: Buffer.byteLength(content, "utf8"), sha256: hash },
        rowsWritten: 1,
      };
    },
    "file.retrieve": async (input, ctx) => {
      const config = fileStoreConfig.parse(ctx.config);
      const key = requireString(input, "key", "file.retrieve");
      const path = safeArtifactPath(config.root, key);
      try {
        const content = await readFile(path, "utf8");
        return {
          data: {
            key,
            content,
            sha256: createHash("sha256").update(content).digest("hex"),
          },
          rowsRead: 1,
        };
      } catch {
        abortWith(
          executionFailure({
            error: `No stored artifact for key "${key}".`,
            errorCode: "not_found",
            retryable: false,
          })
        );
      }
    },
  },
  probe: async (ctx) => {
    const config = fileStoreConfig.parse(ctx.config);
    const started = Date.now();
    try {
      await mkdir(join(process.cwd(), config.root), { recursive: true });
      return {
        authorizationOk: true,
        readOk: true,
        latencyMs: Date.now() - started,
        errorCode: null,
        errorMessage: null,
      };
    } catch (err) {
      return {
        authorizationOk: false,
        readOk: false,
        latencyMs: Date.now() - started,
        errorCode: "storage_unavailable",
        errorMessage: err instanceof Error ? err.message : "cannot create storage root",
      };
    }
  },
});
