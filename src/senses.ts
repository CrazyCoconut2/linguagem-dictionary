export type DictionaryElementSense = {
  glosses?: string[];
  examples?: unknown[];
  tags?: unknown;
  topics?: unknown;
  [key: string]: unknown;
};

export function parseLemmaPosSenses(raw: unknown): DictionaryElementSense[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => item && typeof item === 'object') as DictionaryElementSense[];
  } catch {
    return [];
  }
}

export function countLemmaPosSenseStats(raw: unknown): { senses: number; examples: number } {
  const senses = parseLemmaPosSenses(raw);
  let examples = 0;
  for (const sense of senses) {
    if (Array.isArray(sense.examples)) examples += sense.examples.length;
  }
  return { senses: senses.length, examples };
}

export function firstGlossFromSensesRaw(raw: unknown): string {
  for (const sense of parseLemmaPosSenses(raw)) {
    const gloss = sense.glosses?.[0]?.trim();
    if (gloss) return gloss;
  }
  return '';
}

export function sensesByPosFromRows(
  rows: Array<{ pos: string; senses?: unknown }>,
): Record<string, DictionaryElementSense[]> {
  const sensesByPos: Record<string, DictionaryElementSense[]> = {};
  for (const row of rows) {
    const pos = typeof row.pos === 'string' ? row.pos.trim() : '';
    if (!pos) continue;
    const senses = parseLemmaPosSenses(row.senses);
    if (senses.length) sensesByPos[pos] = senses;
  }
  return sensesByPos;
}
