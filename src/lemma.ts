import { BIND_CHUNK, posPlaceholders, selectRows } from './sql';
import {
  countLemmaPosSenseStats,
  firstGlossFromSensesRaw,
  sensesByPosFromRows,
  type DictionaryElementSense,
} from './senses';

export type DictionaryLemmaEntry = {
  lemma: string;
  partsOfSpeech: string[];
};

export type DictionaryLemmaDetail = DictionaryLemmaEntry & {
  forms: string[];
  sensesByPos: Record<string, DictionaryElementSense[]>;
};

export type DictionaryTermLookupMatch = {
  lemma: string;
  partsOfSpeech: string[];
  via: 'lemma' | 'form';
};

export type DictionaryLemmaSenseStats = {
  senseCountByLemma: Record<string, number>;
  exampleCountByLemma: Record<string, number>;
  previewDefinitionByLemma: Record<string, string>;
};

export type DictionaryLemmaListResult = {
  entries: DictionaryLemmaEntry[];
  formCountByLemma: Record<string, number>;
  senseCountByLemma: Record<string, number>;
  exampleCountByLemma: Record<string, number>;
  previewDefinitionByLemma: Record<string, string>;
};

const TERM_LOOKUP_LIMIT = 20;

function buildLemmaEntry(lemma: string, poses: string[]): DictionaryLemmaEntry {
  return {
    lemma,
    partsOfSpeech: [...new Set(poses)].filter(Boolean).sort((a, b) => a.localeCompare(b)),
  };
}

async function listPosAndSensesForLemma(
  db: D1Database,
  lemma: string,
): Promise<{ poses: string[]; sensesByPos: Record<string, DictionaryElementSense[]> }> {
  const rows = await selectRows<{ pos: string; senses?: string | null }>(
    db,
    `SELECT pos, senses FROM lemma_pos WHERE lemma = ? ORDER BY pos COLLATE NOCASE`,
    [lemma],
  );
  const poses = rows
    .map((row) => (typeof row.pos === 'string' ? row.pos.trim() : ''))
    .filter(Boolean);
  return { poses, sensesByPos: sensesByPosFromRows(rows) };
}

async function listPosByLemmas(
  db: D1Database,
  lemmas: string[],
): Promise<Map<string, string[]>> {
  const posesByLemma = new Map<string, string[]>();
  for (const lemma of lemmas) posesByLemma.set(lemma, []);
  if (lemmas.length === 0) return posesByLemma;
  for (let offset = 0; offset < lemmas.length; offset += BIND_CHUNK) {
    const chunk = lemmas.slice(offset, offset + BIND_CHUNK);
    const rows = await selectRows<{ lemma: string; pos: string }>(
      db,
      `SELECT lemma, pos FROM lemma_pos
       WHERE lemma IN (${posPlaceholders(chunk.length)})
       ORDER BY pos COLLATE NOCASE`,
      chunk,
    );
    for (const row of rows) {
      const lemma = typeof row.lemma === 'string' ? row.lemma.trim() : '';
      const pos = typeof row.pos === 'string' ? row.pos.trim() : '';
      if (!lemma || !pos) continue;
      const list = posesByLemma.get(lemma);
      if (list) {
        if (!list.includes(pos)) list.push(pos);
      } else {
        posesByLemma.set(lemma, [pos]);
      }
    }
  }
  return posesByLemma;
}

async function hydrateLookupMatches(
  db: D1Database,
  rows: Array<{ lemma: string; via: string }>,
  cap: number,
): Promise<DictionaryTermLookupMatch[]> {
  const seen = new Set<string>();
  const ordered: Array<{ lemma: string; via: 'lemma' | 'form' }> = [];
  for (const row of rows) {
    const lemma = String(row.lemma ?? '').trim();
    if (!lemma) continue;
    const dedupeKey = lemma.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    ordered.push({ lemma, via: row.via === 'lemma' ? 'lemma' : 'form' });
    if (ordered.length >= cap) break;
  }
  const posesByLemma = await listPosByLemmas(
    db,
    ordered.map((item) => item.lemma),
  );
  const lemmaHits: DictionaryTermLookupMatch[] = [];
  const formHits: DictionaryTermLookupMatch[] = [];
  for (const item of ordered) {
    const match: DictionaryTermLookupMatch = {
      lemma: item.lemma,
      partsOfSpeech: posesByLemma.get(item.lemma) ?? [],
      via: item.via,
    };
    if (item.via === 'lemma') lemmaHits.push(match);
    else formHits.push(match);
  }
  return [...lemmaHits, ...formHits];
}

export async function lookupDictionaryTerm(
  db: D1Database,
  term: string,
  options?: { limit?: number },
): Promise<DictionaryTermLookupMatch[]> {
  const key = term.trim();
  if (!key) return [];
  const requested =
    typeof options?.limit === 'number' && options.limit > 0
      ? Math.floor(options.limit)
      : TERM_LOOKUP_LIMIT;
  const cap = requested;

  const rows = await selectRows<{ lemma: string; via: string }>(
    db,
    `SELECT lemma, via FROM (
       SELECT lemma, 'lemma' AS via FROM lemmas WHERE lemma = ? COLLATE NOCASE
       UNION ALL
       SELECT lemma, 'form' AS via FROM variation_lemmas WHERE form = ? COLLATE NOCASE
     ) AS hits
     ORDER BY CASE via WHEN 'lemma' THEN 0 ELSE 1 END, lemma COLLATE NOCASE
     LIMIT ?`,
    [key, key, cap + 5],
  );

  return hydrateLookupMatches(db, rows, cap);
}

export async function getLemmaDetail(
  db: D1Database,
  lemma: string,
): Promise<DictionaryLemmaDetail | null> {
  const key = lemma.trim();
  if (!key) return null;
  const row = (
    await selectRows<{ lemma: string }>(db, `SELECT lemma FROM lemmas WHERE lemma = ? LIMIT 1`, [key])
  )[0];
  if (!row) return null;
  const { poses, sensesByPos } = await listPosAndSensesForLemma(db, key);
  const formRows = await selectRows<{ form: string }>(
    db,
    `SELECT form FROM variation_lemmas WHERE lemma = ? ORDER BY form COLLATE NOCASE`,
    [key],
  );
  const forms = formRows
    .map((r) => (typeof r.form === 'string' ? r.form.trim() : ''))
    .filter((form) => form && form !== key);
  return { ...buildLemmaEntry(key, poses), forms, sensesByPos };
}

async function listExistingLemmas(db: D1Database, lemmas: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let offset = 0; offset < lemmas.length; offset += BIND_CHUNK) {
    const chunk = lemmas.slice(offset, offset + BIND_CHUNK);
    const rows = await selectRows<{ lemma: string }>(
      db,
      `SELECT lemma FROM lemmas WHERE lemma IN (${posPlaceholders(chunk.length)})`,
      chunk,
    );
    for (const row of rows) {
      if (typeof row.lemma === 'string' && row.lemma) found.add(row.lemma);
    }
  }
  return found;
}

async function loadEntries(
  db: D1Database,
  lemmas: string[],
): Promise<{
  entries: DictionaryLemmaEntry[];
  senseCountByLemma: Record<string, number>;
  exampleCountByLemma: Record<string, number>;
  previewDefinitionByLemma: Record<string, string>;
}> {
  const senseCountByLemma: Record<string, number> = {};
  const exampleCountByLemma: Record<string, number> = {};
  const previewDefinitionByLemma: Record<string, string> = {};
  if (lemmas.length === 0) {
    return { entries: [], senseCountByLemma, exampleCountByLemma, previewDefinitionByLemma };
  }
  for (const lemma of lemmas) {
    senseCountByLemma[lemma] = 0;
    exampleCountByLemma[lemma] = 0;
    previewDefinitionByLemma[lemma] = '';
  }
  const rows = await selectRows<{ lemma: string; pos: string | null; senses?: string | null }>(
    db,
    `SELECT lemmas.lemma AS lemma, lemma_pos.pos AS pos, lemma_pos.senses AS senses
     FROM lemmas
     LEFT JOIN lemma_pos ON lemma_pos.lemma = lemmas.lemma
     WHERE lemmas.lemma IN (${posPlaceholders(lemmas.length)})
     ORDER BY lemmas.lemma, lemma_pos.pos`,
    lemmas,
  );
  const posesByLemma = new Map<string, string[]>();
  for (const row of rows) {
    const lemma = row.lemma;
    const pos = row.pos;
    if (typeof lemma !== 'string') continue;
    let list = posesByLemma.get(lemma);
    if (!list) {
      list = [];
      posesByLemma.set(lemma, list);
    }
    if (typeof pos === 'string' && pos) list.push(pos);
    const stats = countLemmaPosSenseStats(row.senses);
    senseCountByLemma[lemma] = (senseCountByLemma[lemma] ?? 0) + stats.senses;
    exampleCountByLemma[lemma] = (exampleCountByLemma[lemma] ?? 0) + stats.examples;
    if (!previewDefinitionByLemma[lemma]) {
      const gloss = firstGlossFromSensesRaw(row.senses);
      if (gloss) previewDefinitionByLemma[lemma] = gloss;
    }
  }
  const entries: DictionaryLemmaEntry[] = [];
  for (const lemma of lemmas) {
    entries.push(buildLemmaEntry(lemma, posesByLemma.get(lemma) ?? []));
  }
  return { entries, senseCountByLemma, exampleCountByLemma, previewDefinitionByLemma };
}

async function loadFormCounts(
  db: D1Database,
  lemmas: string[],
): Promise<Record<string, number>> {
  const formCountByLemma: Record<string, number> = {};
  if (lemmas.length === 0) return formCountByLemma;
  for (const lemma of lemmas) formCountByLemma[lemma] = 0;
  const rows = await selectRows<{ lemma: string; cnt: number }>(
    db,
    `SELECT lemma, COUNT(*) AS cnt
     FROM variation_lemmas
     WHERE lemma IN (${posPlaceholders(lemmas.length)})
     GROUP BY lemma`,
    lemmas,
  );
  for (const row of rows) {
    if (typeof row.lemma !== 'string' || row.cnt == null) continue;
    const n = Number(row.cnt);
    if (Number.isFinite(n)) formCountByLemma[row.lemma] = n;
  }
  return formCountByLemma;
}

export async function listEntriesForLemmas(
  db: D1Database,
  lemmas: string[],
): Promise<DictionaryLemmaListResult> {
  const empty: DictionaryLemmaListResult = {
    entries: [],
    formCountByLemma: {},
    senseCountByLemma: {},
    exampleCountByLemma: {},
    previewDefinitionByLemma: {},
  };
  const keys = [...new Set(lemmas.map((item) => item.trim()).filter(Boolean))];
  if (keys.length === 0) return empty;
  const existing = await listExistingLemmas(db, keys);
  const present = keys.filter((lemma) => existing.has(lemma));
  if (present.length === 0) return empty;

  const entries: DictionaryLemmaEntry[] = [];
  const formCountByLemma: Record<string, number> = {};
  const senseCountByLemma: Record<string, number> = {};
  const exampleCountByLemma: Record<string, number> = {};
  const previewDefinitionByLemma: Record<string, string> = {};

  for (let offset = 0; offset < present.length; offset += BIND_CHUNK) {
    const chunk = present.slice(offset, offset + BIND_CHUNK);
    const loaded = await loadEntries(db, chunk);
    entries.push(...loaded.entries);
    Object.assign(formCountByLemma, await loadFormCounts(db, chunk));
    Object.assign(senseCountByLemma, loaded.senseCountByLemma);
    Object.assign(exampleCountByLemma, loaded.exampleCountByLemma);
    Object.assign(previewDefinitionByLemma, loaded.previewDefinitionByLemma);
  }

  return {
    entries,
    formCountByLemma,
    senseCountByLemma,
    exampleCountByLemma,
    previewDefinitionByLemma,
  };
}

export async function listSenseStatsForLemmas(
  db: D1Database,
  lemmas: string[],
): Promise<DictionaryLemmaSenseStats> {
  const keys = [...new Set(lemmas.map((item) => item.trim()).filter(Boolean))];
  const senseCountByLemma: Record<string, number> = {};
  const exampleCountByLemma: Record<string, number> = {};
  const previewDefinitionByLemma: Record<string, string> = {};
  for (const lemma of keys) {
    senseCountByLemma[lemma] = 0;
    exampleCountByLemma[lemma] = 0;
    previewDefinitionByLemma[lemma] = '';
  }
  if (keys.length === 0) {
    return { senseCountByLemma, exampleCountByLemma, previewDefinitionByLemma };
  }
  for (let offset = 0; offset < keys.length; offset += BIND_CHUNK) {
    const chunk = keys.slice(offset, offset + BIND_CHUNK);
    const loaded = await loadEntries(db, chunk);
    Object.assign(senseCountByLemma, loaded.senseCountByLemma);
    Object.assign(exampleCountByLemma, loaded.exampleCountByLemma);
    Object.assign(previewDefinitionByLemma, loaded.previewDefinitionByLemma);
  }
  return { senseCountByLemma, exampleCountByLemma, previewDefinitionByLemma };
}
