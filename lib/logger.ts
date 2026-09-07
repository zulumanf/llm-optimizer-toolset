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
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
