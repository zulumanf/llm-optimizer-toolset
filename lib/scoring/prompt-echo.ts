/**
 * Prompt-echo vocabulary (launch fix 2026-08-14): ONE definition of "the
 * prompt itself named this company". Four surfaces (prospect stakes and
 * excerpts, valuable visibility, prospect diagnosis, gap organic rates) each
 * carried a copy built on unbounded `ilike '%name%'`, which silently
 * suppressed common-word brands ("Compass", "Elite") whenever their name
 * appeared INSIDE another word of the prompt ("encompassing", "elites").
 * Matching is now whole-word/phrase — the boundary rule the mention parser
 * itself applies (lib/parsing/prepass.ts) — and the old "skip tokens ≤ 3
 * chars" mitigation is retired: it existed to blunt substring matching and
 * made short-named brands ("eXp") classify differently across surfaces.
 */
import { sql } from "@/db/client";

/** ARE metacharacters escaped so an alias like "RE/MAX (NJ)" matches
 * literally; `]` leads the bracket class per POSIX rules. */
const ARE_SPECIALS = String.raw`([][^$.|?*+(){}\\])`;
const ARE_ESCAPE_REPLACEMENT = String.raw`\\\1`;
/** ARE word-boundary markers, bound as parameters — a `\m` written inline
 * in a JS template literal cooks down to a bare `m`. */
const WORD_START = String.raw`\m`;
const WORD_END = String.raw`\M`;

/**
 * Case-insensitive whole-word/phrase match of alias `t` against the prompt.
 * Correlates on a text alias `t` and a `responses r` alias in the consuming
 * query.
 */
export const TOKEN_ECHOED_IN_PROMPT = sql`r.prompt_text ~* (${WORD_START} || regexp_replace(trim(t), ${ARE_SPECIALS}, ${ARE_ESCAPE_REPLACEMENT}, 'g') || ${WORD_END})`;

/** The prompt named the company by name or any alias. Correlates on
 * `companies c` and `responses r` aliases in the consuming query. */
export const PROMPT_NAMES_COMPANY = sql`exists (
  select 1 from unnest(c.aliases || array[c.name]) as t
  where trim(t) != '' and ${TOKEN_ECHOED_IN_PROMPT}
)`;

/** Echo exclusion: a mention on a prompt that named the company measures our
 * own question coming back, not visibility (the organic rule). */
export const PROMPT_ECHO_EXCLUDED = sql`not ${PROMPT_NAMES_COMPANY}`;
