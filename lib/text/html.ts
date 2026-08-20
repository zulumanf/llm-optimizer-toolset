/** Minimal HTML escaping shared by every surface that renders user or
 * platform text into markup (plan exports, outbound email HTML parts). */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render a plain-text email body as a minimal HTML part: escaped text with
 * hard line breaks, optionally followed by a 1×1 open-tracking pixel. The
 * HTML part is a mechanical rendering of the approved plain text — it must
 * never carry content of its own (spec 092: body_hash stays on the text).
 */
export function plainTextToTrackedHtml(body: string, pixelUrl: string | null): string {
  const escaped = escapeHtml(body).replace(/\r?\n/g, "<br>\n");
  const pixel = pixelUrl
    ? `\n<img src="${escapeHtml(pixelUrl)}" width="1" height="1" alt="" style="display:none">`
    : "";
  return `<div style="font-family:inherit;white-space:normal">${escaped}</div>${pixel}`;
}
