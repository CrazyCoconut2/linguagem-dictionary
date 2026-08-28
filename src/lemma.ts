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
  formsByLemma: Record<string, string[]>;
  formCountByLemma: Record<string, number>;
  senseCountByLemma: Record<string, number>;
  exampleCountByLemma: Record<string, number>;
  previewDefinitionByLemma: Record<string, string>;
  missing: string[];
};

const TERM_LOOKUP_LIMIT = 20;
const FORM_PREVIEW_FETCH_LIMIT = 48;
const FORM_PREVIEW_DISPLAY_LIMIT = 5;

function buildLemmaEntry(lemma: string, poses: string[]): DictionaryLemmaEntry {
  return {
    lemma,
    partsOfSpeech: [...new Set(poses)].filter(Boolean).sort((a, b) => a.localeCompare(b)),
  };
}

export async function listPosForLemma(db: D1Database, lemma: string): Promise<string[]> {
  const rows = await selectRows<{ pos: string }>(
    db,
    `SELECT pos FROM lemma_pos WHERE lemma = ? ORDER BY pos COLLATE NOCASE`,
    [lemma],
  );
  return rows.map((r) => r.pos);
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

export async function listFormsForLemma(
  db: D1Database,
  lemma: string,
  options?: { limit?: number },
): Promise<string[]> {
  const key = lemma.trim();
  if (!key) return [];
  const cap =
    typeof options?.limit === 'number' && options.limit > 0 ? Math.floor(options.limit) : null;
  if (cap == null) {
    const rows = await selectRows<{ form: string }>(
      db,
      `SELECT form FROM variation_lemmas WHERE lemma = ? ORDER BY form COLLATE NOCASE`,
      [key],
    );
    return rows.map((r) => r.form);
  }
  const rows = await selectRows<{ form: string }>(
    db,
    `SELECT form FROM variation_lemmas
     WHERE lemma = ?
     ORDER BY form COLLATE NOCASE
     LIMIT ?`,
    [key, cap],
  );
  return rows.map((r) => r.form);
}

export async function lookupDictionaryTerm(
  db: D1Database,
  term: string,
  options?: { limit?: number },
): Promise<DictionaryTermLookupMatch[]> {
  const key = term.trim();
  if (!key) return [];
  const cap =
    typeof options?.limit === 'number' && options.limit > 0
      ? Math.floor(options.limit)
      : TERM_LOOKUP_LIMIT;

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

  const seen = new Set<string>();
  const lemmaHits: DictionaryTermLookupMatch[] = [];
  const formHits: DictionaryTermLookupMatch[] = [];
  for (const row of rows) {
    const lemma = String(row.lemma ?? '').trim();
    if (!lemma) continue;
    const dedupeKey = lemma.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const via = row.via === 'lemma' ? 'lemma' : 'form';
    const match: DictionaryTermLookupMatch = {
      lemma,
      partsOfSpeech: await listPosForLemma(db, lemma),
      via,
    };
    if (via === 'lemma') lemmaHits.push(match);
    else formHits.push(match);
    if (lemmaHits.length + formHits.length >= cap) break;
  }
  return [...lemmaHits, ...formHits];
}

export async function getDictionaryEntry(
  db: D1Database,
  lemma: string,
): Promise<DictionaryLemmaEntry | null> {
  const key = lemma.trim();
  if (!key) return null;
  const row = (
    await selectRows<{ lemma: string }>(db, `SELECT lemma FROM lemmas WHERE lemma = ? LIMIT 1`, [key])
  )[0];
  if (!row) return null;
  return buildLemmaEntry(key, await listPosForLemma(db, key));
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

export async function listDistinctPos(db: D1Database, maxValues = 200): Promise<string[]> {
  const cap = Math.max(1, Math.min(2000, maxValues));
  const rows = await selectRows<{ pos: string }>(
    db,
    `SELECT DISTINCT pos FROM lemma_pos ORDER BY pos COLLATE NOCASE LIMIT ?`,
    [cap],
  );
  return rows.map((r) => r.pos);
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

async function loadPreviewForms(
  db: D1Database,
  lemmas: string[],
): Promise<{ formsByLemma: Record<string, string[]>; formCountByLemma: Record<string, number> }> {
  const formsByLemma: Record<string, string[]> = {};
  const formCountByLemma: Record<string, number> = {};
  if (lemmas.length === 0) return { formsByLemma, formCountByLemma };
  for (const lemma of lemmas) {
    formsByLemma[lemma] = [];
    formCountByLemma[lemma] = 0;
  }
  const rows = await selectRows<{ lemma: string; form: string; cnt: number }>(
    db,
    `SELECT lemma, form, cnt FROM (
       SELECT lemma, form,
         COUNT(*) OVER (PARTITION BY lemma) AS cnt,
         ROW_NUMBER() OVER (PARTITION BY lemma ORDER BY form) AS rn
       FROM variation_lemmas
       WHERE lemma IN (${posPlaceholders(lemmas.length)})
     ) AS ranked
     WHERE rn <= ?`,
    [...lemmas, FORM_PREVIEW_FETCH_LIMIT],
  );
  const collected = new Map<string, string[]>();
  for (const row of rows) {
    const lemma = row.lemma;
    const form = row.form;
    if (typeof lemma !== 'string' || typeof form !== 'string') continue;
    if (typeof row.cnt === 'number') formCountByLemma[lemma] = row.cnt;
    let list = collected.get(lemma);
    if (!list) {
      list = [];
      collected.set(lemma, list);
    }
    list.push(form);
  }
  for (const lemma of lemmas) {
    formsByLemma[lemma] = (collected.get(lemma) ?? []).slice(0, FORM_PREVIEW_DISPLAY_LIMIT);
  }
  return { formsByLemma, formCountByLemma };
}

export async function listEntriesForLemmas(
  db: D1Database,
  lemmas: string[],
): Promise<DictionaryLemmaListResult> {
  const empty: DictionaryLemmaListResult = {
    entries: [],
    formsByLemma: {},
    formCountByLemma: {},
    senseCountByLemma: {},
    exampleCountByLemma: {},
    previewDefinitionByLemma: {},
    missing: [],
  };
  const keys = [...new Set(lemmas.map((item) => item.trim()).filter(Boolean))];
  if (keys.length === 0) return empty;
  const existing = await listExistingLemmas(db, keys);
  const present = keys.filter((lemma) => existing.has(lemma));
  const missing = keys.filter((lemma) => !existing.has(lemma));
  if (present.length === 0) return { ...empty, missing };

  const entries: DictionaryLemmaEntry[] = [];
  const formsByLemma: Record<string, string[]> = {};
  const formCountByLemma: Record<string, number> = {};
  const senseCountByLemma: Record<string, number> = {};
  const exampleCountByLemma: Record<string, number> = {};
  const previewDefinitionByLemma: Record<string, string> = {};

  for (let offset = 0; offset < present.length; offset += BIND_CHUNK) {
    const chunk = present.slice(offset, offset + BIND_CHUNK);
    const loaded = await loadEntries(db, chunk);
    const forms = await loadPreviewForms(db, chunk);
    entries.push(...loaded.entries);
    Object.assign(formsByLemma, forms.formsByLemma);
    Object.assign(formCountByLemma, forms.formCountByLemma);
    Object.assign(senseCountByLemma, loaded.senseCountByLemma);
    Object.assign(exampleCountByLemma, loaded.exampleCountByLemma);
    Object.assign(previewDefinitionByLemma, loaded.previewDefinitionByLemma);
  }

  return {
    entries,
    formsByLemma,
    formCountByLemma,
    senseCountByLemma,
    exampleCountByLemma,
    previewDefinitionByLemma,
    missing,
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

export async function getPackMetaVersion(db: D1Database): Promise<{
  schemaVersion: string | null;
  version: number | null;
}> {
  const schema = await selectRows<{ value?: string }>(
    db,
    `SELECT value FROM meta WHERE key = ?`,
    ['schema_version'],
  );
  const ver = await selectRows<{ value?: string }>(db, `SELECT value FROM meta WHERE key = ?`, [
    'version',
  ]);
  const raw = ver[0]?.value;
  const n = raw == null ? null : Number(raw);
  return {
    schemaVersion: typeof schema[0]?.value === 'string' ? schema[0].value : null,
    version: n != null && Number.isFinite(n) ? n : null,
  };
}
