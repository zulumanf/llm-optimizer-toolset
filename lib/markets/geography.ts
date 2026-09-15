/**
 * US state reference data (2026-09-14). Canonical geography for market
 * identity lives in markets.id / markets.state_code; this map only turns a
 * state NAME found in immutable text (a frozen prompt, a pack hierarchy)
 * into its code so provenance can be compared programmatically.
 */
export const US_STATE_NAMES: Readonly<Record<string, string>> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
  DC: "District of Columbia",
};

/** State code for a name or code; null when the text is not a US state. */
export function stateCodeFor(nameOrCode: string | null | undefined): string | null {
  if (!nameOrCode) return null;
  const t = nameOrCode.trim();
  if (/^[A-Za-z]{2}$/.test(t) && US_STATE_NAMES[t.toUpperCase()]) return t.toUpperCase();
  const hit = Object.entries(US_STATE_NAMES).find(([, name]) => name.toLowerCase() === t.toLowerCase());
  return hit ? hit[0] : null;
}

/** Case-insensitive POSIX regex matching the state by full name or ", CODE". */
export function statePattern(code: string): string {
  const name = US_STATE_NAMES[code] ?? code;
  return `(\\m${name}\\M|,\\s*${code}\\M)`;
}
