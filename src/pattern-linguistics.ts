import {
  entryPatternsWithinLimits,
  formatTokenLabel,
  isPhrasePattern,
  isValidEntryPattern,
  parseEntryPattern,
  type ResolvedEntryPattern,
} from 'learner';
import {
  resolveDictionaryPatterns,
  throwIfDictionaryAborted,
  type DictionaryPatternResolutionResult,
  type DictionaryPatternResolveProgress,
} from './resolve';
import { getLemmaDetail } from './lemma';
import { EXHAUSTIVE_FORM_SAFETY_CEILING, PREVIEW_PHRASE_FORM_COMBINATIONS } from './pattern-limits';

type DictionaryResolvedPattern = DictionaryPatternResolutionResult['resolvedPatterns'][number];

function lemmaEntryPattern(lemma: string): string {
  return `${lemma.trim()}~`;
}

function authoredPatterns(lemma: string, patterns?: readonly string[]): string[] {
  const key = lemma.trim();
  if (!Array.isArray(patterns)) return [];
  const normalized = uniqueTrimmed(
    patterns.map((pattern) => (typeof pattern === 'string' ? pattern : '')),
  );
  if (normalized.length === 1 && key && normalized[0] === lemmaEntryPattern(key)) {
    return [];
  }
  return normalized;
}

function uniqueTrimmed(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

export function normalizePersistedPatterns(patterns: string[]): string[] {
  return uniqueTrimmed(patterns.map((pattern) => pattern.trim()).filter(Boolean));
}

export function validateDictionaryElementPatterns(patterns: string[]): void {
  const normalized = normalizePersistedPatterns(patterns);
  if (!normalized.length) return;
  if (!normalized.every(isValidEntryPattern)) {
    throw new Error('One or more patterns are invalid');
  }
  if (!entryPatternsWithinLimits(normalized)) {
    throw new Error('Patterns exceed size or complexity limits');
  }
}

function dictionaryPatternToResolved(
  morphology: DictionaryResolvedPattern,
): ResolvedEntryPattern | null {
  const parsed = parseEntryPattern(morphology.pattern);
  if (!parsed) return null;
  const parts: ResolvedEntryPattern['parts'] = [];
  let slotIndex = 0;
  for (const part of parsed.parts) {
    if (part.type === 'gap') {
      parts.push({ type: 'gap', min: part.min, max: part.max });
      continue;
    }
    const slot = morphology.slots[slotIndex++];
    const forms =
      slot?.forms?.length && slot.forms.some((form) => form.trim())
        ? slot.forms
        : [formatTokenLabel(part.token).replace(/~$/, '')];
    parts.push({ type: 'term', forms });
  }
  return { parts };
}

function phraseResolutionsFromResult(
  patterns: string[],
  result: DictionaryPatternResolutionResult,
): Record<string, ResolvedEntryPattern> {
  const normalized = normalizePersistedPatterns(patterns);
  const out: Record<string, ResolvedEntryPattern> = {};
  for (const pattern of normalized) {
    if (!isPhrasePattern(pattern)) continue;
    const morphology = result.resolvedPatterns.find((entry) => entry.pattern === pattern);
    if (!morphology) continue;
    const resolved = dictionaryPatternToResolved(morphology);
    if (resolved) out[pattern] = resolved;
  }
  return out;
}

function formatGapLabel(gap: { min: number; max: number | null }): string {
  if (gap.max === null) return `{${gap.min},}`;
  if (gap.min === gap.max) return `{${gap.min}}`;
  if (gap.min === 0) return `{,${gap.max}}`;
  return `{${gap.min},${gap.max}}`;
}

function cartesianPhraseForms(
  slotForms: string[][],
  maxCombinations: number,
): { forms: string[]; truncated: boolean } {
  let combos: string[][] = [[]];
  let truncated = false;
  for (const forms of slotForms) {
    if (forms.length === 0) return { forms: [], truncated: false };
    // Spend the combination budget on alternatives per slot, never on slots:
    // every slot must reach the output or the phrases come out truncated.
    const budget = Math.max(1, Math.floor(maxCombinations / Math.max(1, combos.length)));
    if (forms.length > budget) truncated = true;
    const next: string[][] = [];
    for (const prefix of combos) {
      for (const form of forms.slice(0, budget)) {
        next.push([...prefix, form]);
        if (next.length >= maxCombinations) {
          truncated = true;
          break;
        }
      }
      if (next.length >= maxCombinations) break;
    }
    combos = next;
  }
  return { forms: combos.map((parts) => parts.join(' ')), truncated };
}

export type LinguisticsFromResolutionOptions = {
  maxPhraseCombinations?: number;
  maxForms?: number;
};

/**
 * Forms a pattern generates. Parts of speech are deliberately not derived:
 * tagging the entry is the user's call, not the pack's.
 */
export function linguisticsFromResolution(
  lemma: string,
  result: DictionaryPatternResolutionResult,
  patterns: string[] = [],
  options?: LinguisticsFromResolutionOptions,
): {
  forms: string[];
  phraseResolutions: Record<string, ResolvedEntryPattern>;
  truncated: boolean;
} {
  const key = lemma.trim();
  const maxPhraseCombinations =
    typeof options?.maxPhraseCombinations === 'number' && options.maxPhraseCombinations > 0
      ? Math.floor(options.maxPhraseCombinations)
      : PREVIEW_PHRASE_FORM_COMBINATIONS;
  const maxForms =
    typeof options?.maxForms === 'number' && options.maxForms > 0
      ? Math.floor(options.maxForms)
      : maxPhraseCombinations;

  let truncated =
    result.truncated.dictionaryRefs || result.truncated.forms || result.truncated.tokens;
  const collected: string[] = [];
  for (const resolved of result.resolvedPatterns) {
    const { forms, truncated: patternTruncated } = formsFromResolvedPattern(
      resolved,
      key,
      maxPhraseCombinations,
    );
    if (patternTruncated) truncated = true;
    collected.push(...forms);
    if (collected.length >= maxForms) {
      truncated = true;
      break;
    }
  }

  const forms = uniqueTrimmed(collected)
    .filter((form) => form !== key)
    .sort((a, b) => a.localeCompare(b));
  if (forms.length > maxForms) {
    truncated = true;
    forms.length = maxForms;
  }
  return { forms, phraseResolutions: phraseResolutionsFromResult(patterns, result), truncated };
}

function formsFromResolvedPattern(
  resolved: DictionaryResolvedPattern,
  lemma: string,
  maxPhraseCombinations: number,
): { forms: string[]; truncated: boolean } {
  const pattern = resolved.pattern;
  if (!isPhrasePattern(pattern)) {
    return {
      forms: uniqueTrimmed(resolved.slots.flatMap((slot) => slot.forms)).filter(
        (form) => form !== lemma,
      ),
      truncated: resolved.slots.some((slot) => slot.truncated),
    };
  }

  const parsed = parseEntryPattern(pattern);
  if (!parsed) return { forms: [], truncated: false };

  const dimensions: string[][] = [];
  let slotIndex = 0;
  for (const part of parsed.parts) {
    if (part.type === 'gap') {
      dimensions.push([formatGapLabel(part)]);
      continue;
    }
    const slot = resolved.slots[slotIndex++];
    const forms =
      slot?.kind === 'exact' ? [slot.term] : uniqueTrimmed(slot?.forms ?? []);
    if (forms.length === 0) return { forms: [], truncated: false };
    dimensions.push(forms);
  }
  const cartesian = cartesianPhraseForms(dimensions, maxPhraseCombinations);
  return {
    forms: cartesian.forms,
    truncated: cartesian.truncated || resolved.slots.some((slot) => slot.truncated),
  };
}

export type DictionaryElementLinguistics = {
  patterns: string[];
  forms: string[];
  phraseResolutions: Record<string, ResolvedEntryPattern>;
  truncated: boolean;
};

export type ResolveDictionaryElementLinguisticsOptions = {
  onProgress?: (progress: DictionaryPatternResolveProgress) => void;
  signal?: AbortSignal;
};

export async function resolveDictionaryElementLinguistics(
  db: D1Database,
  language: string,
  lemma: string,
  patterns: string[],
  options?: ResolveDictionaryElementLinguisticsOptions,
): Promise<DictionaryElementLinguistics> {
  const key = lemma.trim();
  const normalized = authoredPatterns(key, patterns);
  validateDictionaryElementPatterns(normalized);
  const onProgress = options?.onProgress;
  const signal = options?.signal;
  throwIfDictionaryAborted(signal);
  if (!normalized.length) {
    const detail = await getLemmaDetail(db, key);
    throwIfDictionaryAborted(signal);
    const forms = uniqueTrimmed([...(detail?.forms ?? [])])
      .filter((form) => form !== key)
      .sort((a, b) => a.localeCompare(b));
    onProgress?.({ percent: 100, forms: forms.length });
    return { patterns: [], forms, phraseResolutions: {}, truncated: false };
  }

  const result = await resolveDictionaryPatterns(
    db,
    {
      language,
      patterns: normalized,
      withPartsOfSpeech: false,
      maxLemmas: EXHAUSTIVE_FORM_SAFETY_CEILING,
      maxTokens: EXHAUSTIVE_FORM_SAFETY_CEILING,
    },
    {
      onProgress,
      signal,
    },
  );

  throwIfDictionaryAborted(signal);
  onProgress?.({ percent: 70, forms: result.tokens.length });

  const derived = linguisticsFromResolution(lemma, result, normalized, {
    maxPhraseCombinations: EXHAUSTIVE_FORM_SAFETY_CEILING,
    maxForms: EXHAUSTIVE_FORM_SAFETY_CEILING,
  });
  throwIfDictionaryAborted(signal);
  onProgress?.({
    percent: 99,
    forms: derived.forms.length,
  });
  return { patterns: normalized, ...derived };
}

export type DictionaryElementLinguisticsBatchItem = {
  lemma: string;
  patterns: string[];
};

export async function resolveDictionaryElementsLinguistics(
  db: D1Database,
  language: string,
  items: readonly DictionaryElementLinguisticsBatchItem[],
  options?: ResolveDictionaryElementLinguisticsOptions,
): Promise<DictionaryElementLinguistics[]> {
  const results: DictionaryElementLinguistics[] = [];
  const total = items.length;
  for (let index = 0; index < items.length; index++) {
    const item = items[index]!;
    const resolved = await resolveDictionaryElementLinguistics(
      db,
      language,
      item.lemma,
      item.patterns,
      {
        signal: options?.signal,
        onProgress: (progress) => {
          if (!options?.onProgress || total === 0) return;
          const base = (index / total) * 100;
          const span = 100 / total;
          options.onProgress({
            percent: Math.min(99, Math.round(base + (progress.percent / 100) * span)),
            forms: progress.forms,
          });
        },
      },
    );
    results.push(resolved);
  }
  options?.onProgress?.({ percent: 100, forms: results.reduce((n, item) => n + item.forms.length, 0) });
  return results;
}
