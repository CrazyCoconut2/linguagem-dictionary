/** Pack / cartesian caps for live pattern preview in the create modal. */
export const PATTERN_PREVIEW_MAX_LEMMAS = 256;
export const PATTERN_PREVIEW_MAX_TOKENS = 256;
export const PREVIEW_PHRASE_FORM_COMBINATIONS = 256;

/**
 * Crash-protection ceiling for Create — not a preview cap. Stops IndexedDB,
 * collection cache, and highlight regexes from eating an unbounded wildcard.
 */
export const EXHAUSTIVE_FORM_SAFETY_CEILING = 100_000;

/** Rows per pack page while exhaustively resolving a slot. */
export const EXHAUSTIVE_QUERY_PAGE_SIZE = 1_024;
