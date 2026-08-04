/** Shared ActionResult unwrapper (cleanup audit 2026-08-04, B3): existed as
 * 10 byte-identical copies across the integration suites. */
export const unwrap = <T,>(
  r: { ok: true; data: T } | { ok: false; error: { message: string } }
): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.data;
};
