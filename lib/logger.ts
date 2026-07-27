/** Structured JSON logging (docs/11): events, not narration; never secrets. */
type Level = "info" | "warn" | "error";

export function log(
  level: Level,
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...fields,
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}
