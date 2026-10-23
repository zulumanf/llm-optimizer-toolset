/**
 * Sanitize a LOCAL restored copy of production before a rehearsal
 * (release 151). Irreversible on the copy; refuses anything else.
 *
 *   DATABASE_URL=postgres://localhost:5433/rf_rehearsal_YYYYMMDD npx tsx scripts/sanitize-copy.ts --confirm
 *
 * Guards: local host only; database name must start with `rf_rehearsal`;
 * `--confirm` required. Insert-only triggers are disabled per table on the
 * COPY only, for the duration of the redaction, then re-enabled.
 *
 * Also: nulls external message/thread identifiers, deletes connector
 * connections, cancels queued jobs, disables automation triggers, and runs
 * a generic email/phone scrub over every non-measurement text/jsonb column.
 *
 * Keeps what the rehearsal needs to exercise measurement on real data:
 * captured answers, mentions, citations, scores, companies, prompts, runs.
 * Removes or redacts what a rehearsal never needs: personal contact data,
 * message and reply bodies, operator chat, credentials, session/link tokens.
 * Ends by stamping the database (COMMENT) so rehearsal-151.ts can refuse an
 * unsanitized copy, and by verifying no redacted column still holds an
 * email address.
 */
import "dotenv/config";
import { createHash } from "node:crypto";
import postgres from "postgres";

type Strategy = "email" | "null" | "text" | "name" | "token" | "jsonb_empty";
const REDACT: [table: string, column: string, strategy: Strategy][] = [
  ["users", "email", "email"],
  ["users", "name", "name"],
  ["prospects", "email", "email"],
  ["prospects", "phone", "null"],
  ["prospect_contacts", "email", "email"],
  ["prospect_contacts", "phone", "null"],
  ["prospect_contacts", "name", "name"],
  ["prospect_contacts", "linkedin", "null"],
  ["prospect_contacts", "notes", "null"],
  ["prospect_outreach_sends", "recipient_email", "email"],
  ["prospect_outreach_sends", "open_token", "token"],
  ["prospect_replies", "body_text", "text"],
  ["prospect_audits", "access_token", "token"],
  ["outreach_drafts", "body", "text"],
  ["outreach_drafts", "subject", "text"],
  ["outreach_messages", "body", "text"],
  ["outreach_messages", "subject", "text"],
  ["outreach_sequences", "recipient_email", "email"],
  ["outreach_sender_identity", "reply_to_email", "email"],
  ["outreach_sender_identity", "postal_address", "text"],
  ["outreach_sender_identity", "sender_name", "name"],
  ["profile_correction_destinations", "email", "email"],
  ["profile_correction_drafts", "email", "jsonb_empty"],
  ["profile_correction_drafts", "from_address", "email"],
  ["support_requests", "sender_email", "email"],
  ["support_requests", "body", "text"],
  ["support_requests", "subject", "text"],
  ["audit_requests", "email", "email"],
  ["client_engagements", "primary_contact_name", "name"],
  ["artifact_access_log", "ip_address", "null"],
  ["assistant_pending_actions", "token", "token"],
];
/** Whole tables a rehearsal never needs (credentials, sessions, chats). */
const DELETE = [
  "connector_credentials",
  "mcp_tokens",
  "prospect_report_sessions",
  "assistant_messages",
  "webhook_endpoints",
];

/** Identifiers that address real external objects (Gmail threads, sent
 * messages, CMS drafts): nulled so nothing on the copy can act on them. */
const EXTERNAL_IDS: [string, string][] = [
  ["prospect_outreach_sends", "gmail_thread_id"],
  ["prospect_outreach_sends", "provider_message_id"],
  ["outreach_messages", "provider_message_id"],
  ["prospect_replies", "gmail_message_id"],
  ["profile_correction_drafts", "gmail_draft_id"],
  ["profile_correction_drafts", "gmail_message_id"],
  ["profile_correction_drafts", "gmail_thread_id"],
];

/**
 * Measurement tables are kept verbatim — they ARE the rehearsal. Their text
 * is captured public web/AI output, not personal records. Every OTHER text
 * or jsonb column gets the generic email/phone scrub below, because personal
 * data hides in free text and JSON (notes, audit details, gate verdicts).
 */
const SCRUB_EXEMPT = new Set([
  "responses", "mentions", "response_citations", "response_parses", "sources",
  "prompts", "prompt_sets", "prompt_set_versions", "scores", "scores_staging",
  "score_estimates", "companies", "competitors", "schema_migrations",
  "scoring_state", "scoring_state_history", "runs",
]);
// Postgres ARE syntax. Already-redacted addresses (@example.invalid) are
// skipped so redaction is idempotent and never collides on unique columns.
const EMAIL_RE = String.raw`[A-Za-z0-9._%+-]+@(?!example\.invalid)[A-Za-z0-9.-]+\.[A-Za-z]{2,}`;
// Separators required and no adjacent digits: digit runs inside numbers,
// ids and JSON numerics are never mistaken for phone numbers.
const PHONE_RE = String.raw`(?<![0-9])\+?\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}(?![0-9])`;

const LOCAL = new Set(["localhost", "127.0.0.1", "::1"]);
/** Quote an identifier for sql.unsafe (doubles embedded quotes). */
const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
const h = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 12);

async function main(): Promise<void> {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://invalid");
  const dbName = url.pathname.replace(/^\//, "");
  if (!LOCAL.has(url.hostname)) throw new Error(`refusing: ${url.hostname} is not local`);
  if (!dbName.startsWith("rf_rehearsal")) throw new Error(`refusing: database "${dbName}" must be named rf_rehearsal*`);
  if (!process.argv.includes("--confirm")) throw new Error("refusing without --confirm (this is irreversible on the copy)");
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const report: Record<string, number | string> = {};
  try {
    const exists = async (t: string, c?: string) =>
      (
        await sql`select 1 from information_schema.columns where table_schema = 'public' and table_name = ${t}
          and (${c ?? null}::text is null or column_name = ${c ?? null})`
      ).length > 0;

    for (const t of DELETE) {
      if (!(await exists(t))) continue;
      // TRUNCATE … CASCADE: dependent access/event logs of these tables
      // (e.g. report access events) go with them; nothing else references them.
      const [row] = await sql.unsafe(`select count(*)::int as n from ${q(t)}`);
      const n = (row as { n?: number } | undefined)?.n ?? 0;
      await sql.unsafe(`truncate table ${q(t)} cascade`);
      report[`deleted ${t}`] = Number(n);
    }
    // Connections are referenced by history (drafts, sync runs): revoke, don't delete.
    if (await exists("connector_connections", "status")) {
      await sql.unsafe(`alter table connector_connections disable trigger user`);
      try {
        const r = await sql.unsafe(`update connector_connections set status = 'revoked', revoked_at = coalesce(revoked_at, now()) where status <> 'revoked' or revoked_at is null`);
        report["connector connections revoked"] = r.count;
      } finally {
        await sql.unsafe(`alter table connector_connections enable trigger user`);
      }
    }

    // Explicit map, plus any other text column named like email/phone.
    // Base tables only: information_schema.columns also lists views.
    const extra = await sql`
      select c.table_name, c.column_name from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE' and c.data_type = 'text'
        and c.column_name ~* '(^|_)(email|phone)($|_)'
        and c.column_name !~* '(sha256|version|provided|verified|status|domain)'
    `;
    const plan = [...REDACT];
    for (const e of extra) {
      const key = [e.table_name as string, e.column_name as string];
      if (!plan.some(([t, c]) => t === key[0] && c === key[1])) {
        plan.push([key[0]!, key[1]!, /email/i.test(key[1]!) ? "email" : "null"]);
      }
    }
    for (const [table, column, strategy] of plan) {
      if (!(await exists(table, column))) continue;
      const expr =
        strategy === "email"
          ? `case when ${q(column)} is null then null else 'redacted+' || substr(md5(${q(column)}), 1, 10) || '@example.invalid' end`
          : strategy === "null"
            ? "null"
            : strategy === "text"
              ? `case when ${q(column)} is null then null else '[redacted]' end`
              : strategy === "name"
                ? `case when ${q(column)} is null then null else 'Person ' || substr(md5(${q(column)}), 1, 6) end`
                : strategy === "token"
                  ? `case when ${q(column)} is null then null else md5(random()::text || ${q(column)}) end`
                  : `case when ${q(column)} is null then null else '{}'::jsonb end`;
      await sql.unsafe(`alter table ${q(table)} disable trigger user`);
      try {
        const r = await sql.unsafe(`update ${q(table)} set ${q(column)} = ${expr} where ${q(column)} is not null`);
        report[`${table}.${column}`] = r.count;
      } catch (err) {
        // A NOT NULL column cannot take null: fall back to a redaction marker.
        if (strategy === "null") {
          const r = await sql.unsafe(`update ${q(table)} set ${q(column)} = '[redacted]' where ${q(column)} is not null`);
          report[`${table}.${column}`] = r.count;
        } else throw err;
      } finally {
        await sql.unsafe(`alter table ${q(table)} enable trigger user`);
      }
    }

    for (const [table, column] of EXTERNAL_IDS) {
      if (!(await exists(table, column))) continue;
      await sql.unsafe(`alter table ${q(table)} disable trigger user`);
      try {
        const r = await sql.unsafe(`update ${q(table)} set ${q(column)} = null where ${q(column)} is not null`);
        report[`external id ${table}.${column}`] = r.count;
      } catch {
        const r = await sql.unsafe(`update ${q(table)} set ${q(column)} = 'redacted-' || md5(${q(column)}) where ${q(column)} is not null`);
        report[`external id ${table}.${column}`] = r.count;
      } finally {
        await sql.unsafe(`alter table ${q(table)} enable trigger user`);
      }
    }

    // Nothing on the copy may act: cancel queued work, disable triggers.
    if (await exists("jobs")) {
      const r = await sql`update jobs set status = 'failed', last_error = 'sanitized rehearsal copy' where status in ('queued', 'running')`;
      report["jobs cancelled"] = r.count;
    }
    if (await exists("automation_triggers", "enabled")) {
      const r = await sql`update automation_triggers set enabled = false where enabled`;
      report["automation triggers disabled"] = r.count;
    }

    // JSON-safe scrub: if replacing phones would break the document (should
    // not happen with the separator rule), fall back to emails only — an
    // email can never sit inside a JSON number, so that replacement is safe.
    await sql.unsafe(`
      create or replace function pg_temp.rf_scrub_json(v jsonb, er text, pr text) returns jsonb
      language plpgsql as $f$
      begin
        begin
          return regexp_replace(regexp_replace(v::text, er, 'redacted@example.invalid', 'g'), pr, '[phone]', 'g')::jsonb;
        exception when others then
          return regexp_replace(v::text, er, 'redacted@example.invalid', 'g')::jsonb;
        end;
      end;
      $f$`);

    // Generic scrub: emails and phone numbers in every other text/jsonb column.
    const columns = await sql`
      select c.table_name, c.column_name, c.data_type from information_schema.columns c
      join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
      where c.table_schema = 'public' and t.table_type = 'BASE TABLE'
        and c.data_type in ('text', 'character varying', 'jsonb')
    `;
    let scrubbed = 0;
    for (const c of columns) {
      const table = c.table_name as string;
      const column = c.column_name as string;
      if (SCRUB_EXEMPT.has(table)) continue;
      const isJson = c.data_type === "jsonb";
      const val = isJson ? `${q(column)}::text` : `${q(column)}`;
      const replaced = isJson
        ? `pg_temp.rf_scrub_json(${q(column)}, '${EMAIL_RE}', '${PHONE_RE}')`
        : `regexp_replace(regexp_replace(${val}, '${EMAIL_RE}', 'redacted@example.invalid', 'g'), '${PHONE_RE}', '[phone]', 'g')`;
      await sql.unsafe(`alter table ${q(table)} disable trigger user`);
      try {
        const r = await sql.unsafe(
          `update ${q(table)} set ${q(column)} = ${replaced}
           where ${q(column)} is not null and ${val} ~ '(${EMAIL_RE})|(${PHONE_RE})'`
        );
        scrubbed += r.count;
      } catch (err) {
        // Never silent: a column that could not be scrubbed is reported, and
        // the final verification below fails the run if it still holds email.
        report[`SKIPPED ${table}.${column}`] = err instanceof Error ? err.message.slice(0, 160) : "unknown";
      } finally {
        await sql.unsafe(`alter table ${q(table)} enable trigger user`);
      }
    }
    report["generic scrub rows"] = scrubbed;

    // Verify: no redacted email column still holds a real address.
    let leaks = 0;
    for (const [table, column, strategy] of plan) {
      if (strategy !== "email" || !(await exists(table, column))) continue;
      const [row] = await sql.unsafe(
        `select count(*)::int as n from ${q(table)} where ${q(column)} is not null and ${q(column)} !~ '@example\\.invalid$'`
      );
      leaks += Number(row?.n ?? 0);
    }
    // And no email address remains in any non-exempt text/jsonb column.
    for (const c of columns) {
      const table = c.table_name as string;
      if (SCRUB_EXEMPT.has(table)) continue;
      const val = c.data_type === "jsonb" ? `${q(c.column_name as string)}::text` : `${q(c.column_name as string)}`;
      const [row] = await sql.unsafe(
        `select count(*)::int as n from ${q(table)} where ${val} ~ '${EMAIL_RE}'`
      );
      if (Number(row?.n ?? 0) > 0) {
        leaks += Number(row?.n);
        report[`LEAK ${table}.${c.column_name as string}`] = Number(row?.n);
      }
    }
    if (leaks > 0) {
      const where = Object.entries(report).filter(([k]) => k.startsWith("LEAK") || k.startsWith("SKIPPED"));
      throw new Error(`verification failed: ${leaks} value(s) still contain an email address — ${JSON.stringify(Object.fromEntries(where))}`);
    }
    const stamp = `rf-sanitized v1 ${new Date().toISOString()} ${h(JSON.stringify(report))}`;
    await sql.unsafe(`comment on database ${q(dbName)} is '${stamp.replace(/'/g, "")}'`);
    report.stamp = stamp;
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await sql.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
