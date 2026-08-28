/**
 * Pattern / wildcard resolution against a language D1 pack.
 */

import {
  formatMatchLabel,
  formatTokenLabel,
  isPhrasePattern,
  normalizeEntryForm,
  parseEntryPattern,
} from 'learner';
import { BIND_CHUNK, posPlaceholders, selectRows, selectScalar, type SqlValue } from './sql';
import { EXHAUSTIVE_FORM_SAFETY_CEILING, EXHAUSTIVE_QUERY_PAGE_SIZE } from './pattern-limits';

export function dictionaryAbortError(): Error {
  const error = new Error('Cancelled');
  error.name = 'AbortError';
  return error;
}

export function isDictionaryAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export function throwIfDictionaryAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : dictionaryAbortError();
}

const UNBOUNDED_QUERY_LIMIT = 2_147_483_647;

export type DictionaryPatternResolutionQuery = {
  language: string;
  patterns: string[];
  maxLemmas?: number;
  maxTokens?: number;
  /**
   * Look up POS labels for every matched lemma (default true). Callers that
   * only need forms can skip it — it is the most expensive part of a wildcard.
   */
  withPartsOfSpeech?: boolean;
  /**
   * When set, also COUNT how many unique forms Create would persist for this
   * lemma (uncapped, safety-ceiling applied). Preview uses this for the total.
   */
  countFormsForLemma?: string;
};

export type DictionaryPatternResolveProgress = {
  percent: number;
  forms: number;
};

export type ResolveDictionaryPatternsOptions = {
  onProgress?: (progress: DictionaryPatternResolveProgress) => void;
  signal?: AbortSignal;
};

type DictionaryPatternTermKind = 'exact' | 'lemma' | 'glob' | 'lemma-glob';

type DictionaryResolvedPatternSlot = {
  /** Zero-based lexical slot index within the pattern (gaps are not slots). */
  slotIndex: number;
  /** Normalized strict-pattern term, including `~` / `*` syntax (without POS suffix). */
  term: string;
  kind: DictionaryPatternTermKind;
  /** Optional POS labels — only lemmas tagged with one of these are kept. */
  posFilter: string[];
  /** Concrete forms that may be substituted when compiling this slot. */
  forms: string[];
  /** True when the pack query hit its safety cap before this slot was exhausted. */
  truncated: boolean;
};

type DictionaryResolvedPattern = {
  patternIndex: number;
  pattern: string;
  slots: DictionaryResolvedPatternSlot[];
};

type DictionaryRef = {
  lemma: string;
  /** Only forms that caused this dictionary row to match; includes the lemma when applicable. */
  matchedForms: string[];
  /** Sorted unique POS labels from lemma_pos for this lemma. */
  partsOfSpeech: string[];
};

export type DictionaryPatternResolutionResult = {
  resolvedPatterns: DictionaryResolvedPattern[];
  dictionaryRefs: DictionaryRef[];
  tokens: string[];
  truncated: {
    dictionaryRefs: boolean;
    forms: boolean;
    tokens: boolean;
  };
  /** Unique forms Create would persist; set when `countFormsForLemma` is passed. */
  formCount?: number;
};

/**
 * POS labels for many lemmas at once. A wildcard slot can match tens of
 * thousands of lemmas, so this must not degrade into one query per lemma.
 */
async function listPosForLemmas(db: D1Database, lemmas: string[]): Promise<Map<string, string[]>> {
  const byLemma = new Map<string, string[]>();
  for (let offset = 0; offset < lemmas.length; offset += BIND_CHUNK) {
    const chunk = lemmas.slice(offset, offset + BIND_CHUNK);
    const rows = await selectRows<{ lemma: string; pos: string }>(
      db,
      `SELECT lemma, pos FROM lemma_pos
       WHERE lemma IN (${posPlaceholders(chunk.length)})
       ORDER BY lemma, pos COLLATE NOCASE`,
      chunk,
    );
    for (const row of rows) {
      const lemma = String(row.lemma ?? '');
      const pos = String(row.pos ?? '').trim();
      if (!lemma || !pos) continue;
      const list = byLemma.get(lemma);
      if (list) list.push(pos);
      else byLemma.set(lemma, [pos]);
    }
  }
  return byLemma;
}

type DictionaryTermMatchRow = {
  lemma: string;
  matchedForm: string;
};

type ParsedDictionaryPattern = {
  patternIndex: number;
  pattern: string;
  slots: Array<Omit<DictionaryResolvedPatternSlot, 'forms' | 'truncated'>>;
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

async function yieldForProgress(
  onProgress?: (progress: DictionaryPatternResolveProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  throwIfDictionaryAborted(signal);
  if (!onProgress && !signal) return;
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  throwIfDictionaryAborted(signal);
}

/** Resolve strict lexical slots without treating the whole pattern as a lemma regex. */
export async function resolveDictionaryPatterns(
  db: D1Database,
  query: DictionaryPatternResolutionQuery,
  options?: ResolveDictionaryPatternsOptions,
): Promise<DictionaryPatternResolutionResult> {
  const language = query.language.trim().toLowerCase();
  const maxLemmas =
    typeof query.maxLemmas === 'number' && query.maxLemmas > 0
      ? Math.floor(query.maxLemmas)
      : UNBOUNDED_QUERY_LIMIT;
  const maxTokens =
    typeof query.maxTokens === 'number' && query.maxTokens > 0
      ? Math.floor(query.maxTokens)
      : UNBOUNDED_QUERY_LIMIT;
  const parsed = parseDictionaryPatterns(query.patterns ?? []);
  const state = createDictionaryResolutionState(parsed, maxLemmas, maxTokens);
  const onProgress = options?.onProgress;
  const signal = options?.signal;
  throwIfDictionaryAborted(signal);
  const report = (percent: number) => {
    onProgress?.({ percent: clampPercent(percent), forms: state.tokens.length });
  };
  report(0);
  if (!language) {
    report(70);
    return await withExpectedFormCount(await finishDictionaryResolution(state), parsed, query, null);
  }

  const rowLimit = Math.min(UNBOUNDED_QUERY_LIMIT, maxLemmas + maxTokens + 1);
  const pageSize = EXHAUSTIVE_QUERY_PAGE_SIZE;
  const usePaging = rowLimit > pageSize;
  const totalSlots = Math.max(
    1,
    parsed.reduce((count, pattern) => count + pattern.slots.length, 0),
  );
  let slotsDone = 0;

  for (const pattern of parsed) {
    for (const slot of pattern.slots) {
      throwIfDictionaryAborted(signal);
      if (usePaging) {
        const slotTruncated = await addDictionaryTermRowsPaged(
          db,
          state,
          pattern.patternIndex,
          slot,
          pageSize,
          (fetched, slotTotal) => {
            const slotFraction = slotTotal > 0 ? Math.min(1, fetched / slotTotal) : 1;
            report(((slotsDone + slotFraction) / totalSlots) * 70);
          },
          signal,
        );
        if (slotTruncated) {
          state.truncatedSlots.add(`${pattern.patternIndex}:${slot.slotIndex}`);
          state.dictionaryRefsTruncated = true;
          state.tokensTruncated = true;
        }
      } else {
        const queried = await queryDictionaryTermRows(db, slot, rowLimit, 0);
        addDictionaryTermRows(
          state,
          pattern.patternIndex,
          slot.slotIndex,
          queried.rows.slice(0, Math.max(0, rowLimit - 1)),
        );
        if (queried.truncated) {
          state.truncatedSlots.add(`${pattern.patternIndex}:${slot.slotIndex}`);
          state.dictionaryRefsTruncated = true;
          state.tokensTruncated = true;
        }
        report(((slotsDone + 1) / totalSlots) * 70);
      }
      slotsDone += 1;
      await yieldForProgress(onProgress, signal);
    }
  }
  report(70);
  const result = await finishDictionaryResolution(
    state,
    query.withPartsOfSpeech === false ? null : db,
  );
  return await withExpectedFormCount(result, parsed, query, db);
}

function parseDictionaryPatterns(patterns: string[]): ParsedDictionaryPattern[] {
  return patterns.map((rawPattern, patternIndex) => {
    const pattern = String(rawPattern ?? '').trim();
    const slots: ParsedDictionaryPattern['slots'] = [];
    const parsed = parseEntryPattern(pattern);
    if (!parsed) return { patternIndex, pattern, slots };
    const lowerPattern = pattern.toLowerCase();
    let sourceOffset = 0;
    for (const part of parsed.parts) {
      if (part.type !== 'match') continue;
      const label = formatMatchLabel(part);
      const normalizedTerm = formatTokenLabel(part.token);
      const sourceIndex = lowerPattern.indexOf(label.toLowerCase(), sourceOffset);
      const term =
        sourceIndex >= 0
          ? pattern.slice(sourceIndex, sourceIndex + normalizedTerm.length)
          : normalizedTerm;
      if (sourceIndex >= 0) sourceOffset = sourceIndex + label.length;
      const kind: DictionaryPatternTermKind =
        part.token.kind === 'lemma'
          ? 'lemma'
          : part.token.kind === 'wildcard'
            ? part.token.lemma
              ? 'lemma-glob'
              : 'glob'
            : 'exact';
      slots.push({
        slotIndex: slots.length,
        term,
        kind,
        posFilter: [...(part.posFilter ?? [])],
      });
    }
    return { patternIndex, pattern, slots };
  });
}

function dictionaryTermValue(slot: Pick<DictionaryResolvedPatternSlot, 'term' | 'kind'>): string {
  return slot.kind === 'lemma' || slot.kind === 'lemma-glob' ? slot.term.slice(0, -1) : slot.term;
}

/** D1 GLOB patterns are capped at 50 bytes. Same `*` → `?*` encoding as the pack client. */
function globPattern(value: string): string {
  const encoded = value.replaceAll('*', '?*');
  return encoded.length <= 50 ? encoded : encoded.slice(0, 50);
}

/** `WHERE` clause keeping only hits whose lemma carries one of the requested POS. */
function dictionaryTermPosFilterSql(posFilter: string[]): { sql: string; bind: string[] } {
  if (posFilter.length === 0) return { sql: '', bind: [] };
  return {
    sql: `WHERE EXISTS (
        SELECT 1 FROM lemma_pos lp
        WHERE lp.lemma = hits.lemma AND lp.pos IN (${posPlaceholders(posFilter.length)})
      )`,
    bind: posFilter,
  };
}

function dictionaryTermHitsQuery(
  slot: Omit<DictionaryResolvedPatternSlot, 'forms' | 'truncated'>,
): { sql: string; bind: SqlValue[]; orderBy: string } {
  const value = dictionaryTermValue(slot);
  const pos = dictionaryTermPosFilterSql(slot.posFilter);
  if (slot.kind === 'lemma') {
    return {
      sql: `SELECT lemma, matchedForm FROM (
         SELECT lemma, lemma AS matchedForm FROM lemmas WHERE lemma = ?
         UNION ALL
         SELECT lemma, form AS matchedForm FROM variation_lemmas WHERE lemma = ?
       ) AS hits
       ${pos.sql}`,
      bind: [value, value, ...pos.bind],
      orderBy: 'ORDER BY matchedForm COLLATE NOCASE',
    };
  }
  if (slot.kind === 'lemma-glob') {
    const queryValue = globPattern(value);
    return {
      sql: `SELECT lemma, matchedForm FROM (
         SELECT lemma, lemma AS matchedForm FROM lemmas WHERE lemma GLOB ?
         UNION ALL
         SELECT lemma, form AS matchedForm FROM variation_lemmas WHERE lemma GLOB ?
       ) AS hits
       ${pos.sql}`,
      bind: [queryValue, queryValue, ...pos.bind],
      orderBy: 'ORDER BY lemma, matchedForm COLLATE NOCASE',
    };
  }
  const operator = slot.kind === 'glob' ? 'GLOB' : '=';
  const queryValue = slot.kind === 'glob' ? globPattern(value) : value;
  return {
    sql: `SELECT lemma, matchedForm FROM (
         SELECT lemma, lemma AS matchedForm FROM lemmas WHERE lemma ${operator} ?
         UNION ALL
         SELECT lemma, form AS matchedForm FROM variation_lemmas WHERE form ${operator} ?
       ) AS hits
       ${pos.sql}`,
    bind: [queryValue, queryValue, ...pos.bind],
    orderBy: 'ORDER BY lemma, matchedForm COLLATE NOCASE',
  };
}

async function countDictionaryTermRows(
  db: D1Database,
  slot: Omit<DictionaryResolvedPatternSlot, 'forms' | 'truncated'>,
): Promise<number> {
  const { sql, bind } = dictionaryTermHitsQuery(slot);
  return await selectScalar(db, `SELECT COUNT(*) AS v FROM (${sql}) AS counted`, bind);
}

async function withExpectedFormCount(
  result: DictionaryPatternResolutionResult,
  parsed: ParsedDictionaryPattern[],
  query: DictionaryPatternResolutionQuery,
  db: D1Database | null,
): Promise<DictionaryPatternResolutionResult> {
  if (query.countFormsForLemma === undefined) return result;
  return {
    ...result,
    formCount: await countExpectedCreatedForms(parsed, db, normalizeEntryForm(query.countFormsForLemma)),
  };
}

/** Unique forms Create would persist for these patterns (capped at the safety ceiling). */
async function countExpectedCreatedForms(
  parsed: ParsedDictionaryPattern[],
  db: D1Database | null,
  lemma: string,
): Promise<number> {
  const ceiling = EXHAUSTIVE_FORM_SAFETY_CEILING;
  let total = 0;
  const singleTokenSlots: ParsedDictionaryPattern['slots'] = [];
  for (const pattern of parsed) {
    if (!pattern.pattern) continue;
    if (isPhrasePattern(pattern.pattern)) {
      total += await countExpectedPhraseForms(pattern, db, lemma);
      if (total >= ceiling) return ceiling;
      continue;
    }
    singleTokenSlots.push(...pattern.slots);
  }
  if (singleTokenSlots.length > 0) {
    total += await countExpectedSingleTokenForms(singleTokenSlots, db, lemma);
  }
  return Math.min(ceiling, Math.max(0, total));
}

async function countExpectedPhraseForms(
  pattern: ParsedDictionaryPattern,
  db: D1Database | null,
  lemma: string,
): Promise<number> {
  if (pattern.slots.length === 0) return 0;
  const ceiling = EXHAUSTIVE_FORM_SAFETY_CEILING;
  let product = 1;
  for (const slot of pattern.slots) {
    const n = await countSlotDistinctForms(slot, db);
    if (n <= 0) return 0;
    product = multiplyCapped(product, n, ceiling);
    if (product >= ceiling) return ceiling;
  }
  if (product === 1 && lemma) {
    const exact = exactPhraseForm(pattern);
    if (exact && normalizeEntryForm(exact) === lemma) return 0;
  }
  return product;
}

function exactPhraseForm(pattern: ParsedDictionaryPattern): string | null {
  if (pattern.slots.length === 0 || pattern.slots.some((slot) => slot.kind !== 'exact')) {
    return null;
  }
  return pattern.slots.map((slot) => slot.term).join(' ');
}

async function countExpectedSingleTokenForms(
  slots: ParsedDictionaryPattern['slots'],
  db: D1Database | null,
  lemma: string,
): Promise<number> {
  if (!db) {
    const seen = new Set<string>();
    for (const slot of slots) {
      if (slot.kind !== 'exact') continue;
      const form = normalizeEntryForm(slot.term);
      if (!form || form === lemma || seen.has(form)) continue;
      seen.add(form);
    }
    return seen.size;
  }
  let n = await countDistinctDictionaryTermFormsUnion(db, slots, lemma);
  for (const slot of slots) {
    if (slot.kind !== 'exact') continue;
    const form = normalizeEntryForm(slot.term);
    if (!form || form === lemma) continue;
    if (await countDistinctDictionaryTermFormsUnion(db, [slot], lemma) === 0) n += 1;
  }
  return n;
}

async function countSlotDistinctForms(
  slot: ParsedDictionaryPattern['slots'][number],
  db: D1Database | null,
): Promise<number> {
  // Phrase cartesian always substitutes the typed exact token, even if the pack
  // has no row for it (`I *ove` still yields "I love").
  if (slot.kind === 'exact') return normalizeEntryForm(slot.term) ? 1 : 0;
  if (!db) return 0;
  return await countDistinctDictionaryTermFormsUnion(db, [slot]);
}

async function countDistinctDictionaryTermFormsUnion(
  db: D1Database,
  slots: ParsedDictionaryPattern['slots'],
  excludeForm = '',
): Promise<number> {
  if (slots.length === 0) return 0;
  const parts = slots.map((slot) => dictionaryTermHitsQuery(slot));
  const sql = parts.map((part) => part.sql).join('\nUNION ALL\n');
  const bind: SqlValue[] = parts.flatMap((part) => part.bind);
  const excludeSql = excludeForm ? ' WHERE counted.matchedForm != ?' : '';
  if (excludeForm) bind.push(excludeForm);
  return await selectScalar(
    db,
    `SELECT COUNT(DISTINCT counted.matchedForm) AS v FROM (${sql}) AS counted${excludeSql}`,
    bind,
  );
}

function multiplyCapped(a: number, b: number, cap: number): number {
  if (a <= 0 || b <= 0) return 0;
  if (b > 0 && a > cap / b) return cap;
  return Math.min(cap, a * b);
}

async function queryDictionaryTermRows(
  db: D1Database,
  slot: Omit<DictionaryResolvedPatternSlot, 'forms' | 'truncated'>,
  limit: number,
  offset = 0,
): Promise<{ rows: DictionaryTermMatchRow[]; truncated: boolean }> {
  const { sql, bind, orderBy } = dictionaryTermHitsQuery(slot);
  const rows = await selectRows<DictionaryTermMatchRow>(db, `${sql} ${orderBy} LIMIT ? OFFSET ?`, [
    ...bind,
    limit,
    offset,
  ]);
  return { rows, truncated: rows.length >= limit };
}

async function addDictionaryTermRowsPaged(
  db: D1Database,
  state: DictionaryResolutionState,
  patternIndex: number,
  slot: Omit<DictionaryResolvedPatternSlot, 'forms' | 'truncated'>,
  pageSize: number,
  onPage: (fetched: number, slotTotal: number) => void,
  signal?: AbortSignal,
): Promise<boolean> {
  const slotTotal = await countDictionaryTermRows(db, slot);
  let offset = 0;
  while (offset < slotTotal) {
    throwIfDictionaryAborted(signal);
    if (state.dictionaryRefsTruncated && state.tokensTruncated) {
      return true;
    }
    const queried = await queryDictionaryTermRows(db, slot, pageSize, offset);
    addDictionaryTermRows(state, patternIndex, slot.slotIndex, queried.rows);
    offset += queried.rows.length;
    onPage(offset, slotTotal);
    if (queried.rows.length === 0) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    throwIfDictionaryAborted(signal);
  }
  return offset < slotTotal;
}

type DictionaryResolutionState = {
  resolvedPatterns: DictionaryResolvedPattern[];
  slotForms: Map<string, Set<string>>;
  truncatedSlots: Set<string>;
  dictionaryRefs: Map<string, Set<string>>;
  tokens: string[];
  tokenSet: Set<string>;
  maxLemmas: number;
  maxTokens: number;
  dictionaryRefsTruncated: boolean;
  tokensTruncated: boolean;
};

function createDictionaryResolutionState(
  parsed: ParsedDictionaryPattern[],
  maxLemmas: number,
  maxTokens: number,
): DictionaryResolutionState {
  const resolvedPatterns = parsed.map((pattern) => ({
    patternIndex: pattern.patternIndex,
    pattern: pattern.pattern,
    slots: pattern.slots.map((slot) => ({ ...slot, forms: [], truncated: false })),
  }));
  const state: DictionaryResolutionState = {
    resolvedPatterns,
    slotForms: new Map(),
    truncatedSlots: new Set(),
    dictionaryRefs: new Map(),
    tokens: [],
    tokenSet: new Set(),
    maxLemmas,
    maxTokens,
    dictionaryRefsTruncated: false,
    tokensTruncated: false,
  };
  // Exact slots remain compilable even when a dictionary pack is unavailable.
  for (const pattern of parsed) {
    for (const slot of pattern.slots) {
      if (slot.kind === 'exact') {
        addResolvedForm(state, pattern.patternIndex, slot.slotIndex, slot.term);
      }
    }
  }
  return state;
}

function addResolvedForm(
  state: DictionaryResolutionState,
  patternIndex: number,
  slotIndex: number,
  rawForm: string,
): void {
  const form = normalizeEntryForm(rawForm);
  if (!form) return;
  const slotKey = `${patternIndex}:${slotIndex}`;
  const forms = state.slotForms.get(slotKey) ?? new Set<string>();
  forms.add(form);
  state.slotForms.set(slotKey, forms);
  if (state.tokenSet.has(form)) return;
  if (state.tokens.length >= state.maxTokens) {
    state.tokensTruncated = true;
    return;
  }
  state.tokenSet.add(form);
  state.tokens.push(form);
}

function addDictionaryTermRows(
  state: DictionaryResolutionState,
  patternIndex: number,
  slotIndex: number,
  rows: DictionaryTermMatchRow[],
): void {
  for (const row of rows) {
    const lemma = String(row.lemma ?? '').trim();
    const matchedForm = normalizeEntryForm(row.matchedForm);
    if (!lemma || !matchedForm) continue;
    let forms = state.dictionaryRefs.get(lemma);
    if (!forms) {
      if (state.dictionaryRefs.size >= state.maxLemmas) {
        state.dictionaryRefsTruncated = true;
        continue;
      }
      forms = new Set<string>();
      state.dictionaryRefs.set(lemma, forms);
    }
    forms.add(matchedForm);
    addResolvedForm(state, patternIndex, slotIndex, matchedForm);
  }
}

async function finishDictionaryResolution(
  state: DictionaryResolutionState,
  db: D1Database | null = null,
): Promise<DictionaryPatternResolutionResult> {
  for (const pattern of state.resolvedPatterns) {
    for (const slot of pattern.slots) {
      slot.forms = [...(state.slotForms.get(`${pattern.patternIndex}:${slot.slotIndex}`) ?? [])];
      slot.truncated = state.truncatedSlots.has(`${pattern.patternIndex}:${slot.slotIndex}`);
    }
  }
  const lemmas = [...state.dictionaryRefs.keys()];
  const posByLemma = db ? await listPosForLemmas(db, lemmas) : new Map<string, string[]>();
  const dictionaryRefs = [...state.dictionaryRefs].map(([lemma, matchedForms]) => ({
    lemma,
    matchedForms: [...matchedForms],
    partsOfSpeech: posByLemma.get(lemma) ?? [],
  }));
  return {
    resolvedPatterns: state.resolvedPatterns,
    dictionaryRefs,
    tokens: state.tokens,
    truncated: {
      dictionaryRefs: state.dictionaryRefsTruncated,
      forms: state.truncatedSlots.size > 0,
      tokens: state.tokensTruncated,
    },
  };
}

