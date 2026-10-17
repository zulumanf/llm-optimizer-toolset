/** Structured JSON logging (docs/11): events, not narration; never secrets. */
type Level = "info" | "warn" | "error";

/** Private-report credentials must never reach a log line (spec 134): any
 * /audit/<token>, /audit/<slug>/<key> or /report/<slug>/<key> path segment
 * is redacted wherever it appears in the serialized event. */
const CREDENTIAL_PATHS = [
  /(\/report\/[a-z0-9-]+\/)[A-Za-z0-9_-]{8,}/g,
  /(\/audit\/[^/\s"\\]+\/)[A-Za-z0-9_-]{8,}/g,
  /(\/audit\/)[A-Za-z0-9_-]{32,}/g,
];

export function redactCredentialPaths(line: string): string {
  return CREDENTIAL_PATHS.reduce((acc, re) => acc.replace(re, "$1[redacted]"), line);
}

export function log(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const line = redactCredentialPaths(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...fields,
    })
  );
  if (level === "error") {
    console.error(line);
    forwardError(event, line);
  } else if (level === "warn") console.warn(line);
  else console.log(line);
}

/**
 * Error tracking without a vendor SDK (spec 151 D2): when ERROR_WEBHOOK_URL
 * is set, each error event is POSTed (already redacted) to it — any
 * Slack/Discord/incident webhook or a log drain. Best effort and
 * fire-and-forget: a tracking outage never breaks the caller. Deduped per
 * event name per window so an error loop cannot flood the channel.
 */
export const ERROR_FORWARD_WINDOW_MS = 5 * 60_000;
const lastForwarded = new Map<string, number>();

export function shouldForward(event: string, now: number, seen: Map<string, number> = lastForwarded): boolean {
  const last = seen.get(event);
  if (last !== undefined && now - last < ERROR_FORWARD_WINDOW_MS) return false;
  seen.set(event, now);
  return true;
}

/** Off-platform copies of a log line carry no email addresses or phone numbers. */
export function redactForwarded(line: string): string {
  return line
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\+?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/g, "[phone]");
}

function forwardError(event: string, line: string): void {
  const url = process.env.ERROR_WEBHOOK_URL;
  if (!url || typeof fetch !== "function" || !shouldForward(event, Date.now())) return;
  void fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: `[rf error] ${event}`, event, line: redactForwarded(line).slice(0, 4000) }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => undefined);
}
