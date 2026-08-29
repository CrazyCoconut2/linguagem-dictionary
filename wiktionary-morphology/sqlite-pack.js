/**
 * Write a morphology Map into a SQLite pack.
 *
 * Input map keys: "lemma\0pos" → { forms: Set<form>, senses: Sense[] }
 * Output: <lang>.sqlite
 * Pack version lives in meta.version (not the filename).
 *
 * Indexed on lemma + form PKs (B-tree). No FTS.
 * Exact lookup uses equality; contains uses LIKE '%q%'.
 *
 * Memory: writes by consuming the input map (no full byTerm/formToLemmas duplicate).
 */

import {
  existsSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export const SCHEMA_VERSION = "3";

/** Normalize / validate language code used as the pack basename. */
export function packLang(lang) {
  const code = String(lang ?? "").trim().toLowerCase();
  if (!code) throw new Error("lang is required");
  if (/[/\\]/.test(code) || code.includes("..") || code.includes(".")) {
    throw new Error(`Invalid lang: ${lang}`);
  }
  return code;
}

/** Validate pack version stored in meta (not in the filename). */
export function validateVersion(version) {
  const ver = String(version ?? "").trim();
  if (!ver) throw new Error("version is required");
  if (/[/\\]/.test(ver) || ver.includes("..")) {
    throw new Error(`Invalid version: ${version}`);
  }
  return ver;
}

/**
 * Parse `pt.sqlite`.
 * @returns {{ lang: string, stem: string } | null}
 */
export function parsePackFileName(name) {
  if (!name.endsWith(".sqlite")) return null;
  const stem = name.slice(0, -".sqlite".length);

  if (!stem || stem.includes(".") || /[/\\]/.test(stem) || stem.includes("..")) {
    return null;
  }
  return { lang: stem.toLowerCase(), stem: stem.toLowerCase() };
}

/**
 * Read a meta value from a pack without keeping the DB open.
 * @param {string} sqlitePath
 * @param {string} key
 */
export function readPackMeta(sqlitePath, key) {
  const db = new Database(sqlitePath, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

export const SCHEMA_SQL = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

CREATE TABLE lemmas (
  lemma TEXT PRIMARY KEY NOT NULL
);

CREATE TABLE lemma_pos (
  lemma TEXT NOT NULL REFERENCES lemmas(lemma),
  pos TEXT NOT NULL,
  senses TEXT,
  PRIMARY KEY (lemma, pos)
);
CREATE INDEX idx_lemma_pos_pos ON lemma_pos(pos, lemma);

CREATE TABLE variations (
  form TEXT PRIMARY KEY NOT NULL
);

CREATE TABLE variation_lemmas (
  form TEXT NOT NULL REFERENCES variations(form),
  lemma TEXT NOT NULL REFERENCES lemmas(lemma),
  PRIMARY KEY (form, lemma)
);
CREATE INDEX idx_variation_lemmas_lemma ON variation_lemmas(lemma);
`;

/**
 * Resolve the SQLite path from --out.
 * Accepts `…/lang.sqlite`, a legacy `…/lang.sqlite.gz`, or a basename prefix.
 */
export function resolvePackPaths(outPath) {
  if (outPath.endsWith(".sqlite.gz")) {
    return { sqlitePath: outPath.slice(0, -3) };
  }
  if (outPath.endsWith(".sqlite")) {
    return { sqlitePath: outPath };
  }
  return { sqlitePath: `${outPath}.sqlite` };
}

/**
 * Normalize a map entry to { forms: Set, senses: [] }.
 * Accepts legacy Set<form> or the richer bucket shape.
 * @param {Set<string> | { forms?: Set<string>, senses?: unknown[], senseKeys?: Set<string> } | undefined} value
 */
export function normalizeBucket(value) {
  if (value instanceof Set) {
    return { forms: value, senses: [] };
  }
  return {
    forms: value?.forms instanceof Set ? value.forms : new Set(),
    senses: Array.isArray(value?.senses) ? value.senses : [],
  };
}

/**
 * Drop merge-only senseKeys so they are not held through the write phase.
 * @param {Map<string, unknown>} map
 */
export function stripSenseKeys(map) {
  for (const value of map.values()) {
    if (!value || value instanceof Set) continue;
    if (value.senseKeys instanceof Set) {
      value.senseKeys.clear();
      value.senseKeys = undefined;
    }
  }
}

/**
 * Aggregate map into term → { pos → { forms, senses } }, form → lemmas[].
 * Prefer writeSqlitePack (streaming) for builds; this remains for inspection/tests.
 * @param {Map<string, Set<string> | { forms: Set<string>, senses: unknown[] }>} map
 */
export function aggregateMorphologyMap(map) {
  /** @type {Map<string, Map<string, { forms: string[], senses: unknown[] }>>} */
  const byTerm = new Map();
  /** @type {Map<string, Set<string>>} */
  const formToLemmas = new Map();

  for (const [key, raw] of map) {
    const bucket = normalizeBucket(raw);
    if (!bucket.forms.size && !bucket.senses.length) continue;

    const sep = key.indexOf("\0");
    const term = key.slice(0, sep);
    const pos = key.slice(sep + 1);

    let posMap = byTerm.get(term);
    if (!posMap) {
      posMap = new Map();
      byTerm.set(term, posMap);
    }
    const forms = [...bucket.forms].sort((a, b) => a.localeCompare(b));
    posMap.set(pos, { forms, senses: bucket.senses });

    for (const form of forms) {
      let lemmas = formToLemmas.get(form);
      if (!lemmas) {
        lemmas = new Set();
        formToLemmas.set(form, lemmas);
      }
      lemmas.add(term);
    }
  }

  return { byTerm, formToLemmas };
}

/**
 * Write SQLite pack from morphology map, consuming entries as they are written
 * so peak RAM stays close to the streamed aggregate (no full duplicate index).
 *
 * @param {string} outPath  default …/<lang>.sqlite
 * @param {Map<string, Set<string> | { forms: Set<string>, senses: unknown[], senseKeys?: Set<string> }>} map
 * @param {{ lang: string, version: string, includeSenses?: boolean, onProgress?: (msg: string) => void }} opts
 * @returns {Promise<{ lemmaCount: number, variationCount: number, sqlitePath: string }>}
 */
export async function writeSqlitePack(outPath, map, opts) {
  const lang = packLang(opts.lang);
  const version = validateVersion(opts.version);
  const includeSenses = opts.includeSenses !== false;
  const { onProgress } = opts;
  const { sqlitePath } = resolvePackPaths(outPath);
  const leftoverGz = `${sqlitePath}.gz`;

  mkdirSync(dirname(sqlitePath), { recursive: true });
  if (existsSync(sqlitePath)) unlinkSync(sqlitePath);
  if (existsSync(leftoverGz)) unlinkSync(leftoverGz);

  stripSenseKeys(map);

  // Lightweight lemma → [{ pos, key }] only (no form/sense copies).
  /** @type {Map<string, Array<{ pos: string, key: string }>>} */
  const lemmaIndex = new Map();
  for (const [key, raw] of map) {
    const bucket = normalizeBucket(raw);
    if (!bucket.forms.size && !bucket.senses.length) {
      map.delete(key);
      continue;
    }
    const sep = key.indexOf("\0");
    if (sep < 0) {
      map.delete(key);
      continue;
    }
    const lemma = key.slice(0, sep);
    const pos = key.slice(sep + 1);
    let list = lemmaIndex.get(lemma);
    if (!list) {
      list = [];
      lemmaIndex.set(lemma, list);
    }
    list.push({ pos, key });
  }

  const lemmas = [...lemmaIndex.keys()].sort((a, b) => a.localeCompare(b));
  const lemmaCount = lemmas.length;

  const db = new Database(sqlitePath);
  let variationCount = 0;
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = OFF");
    db.pragma("temp_store = FILE");
    db.exec(SCHEMA_SQL);

    const insertMeta = db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?)",
    );
    insertMeta.run("lang", lang);
    insertMeta.run("version", version);
    insertMeta.run("schema_version", SCHEMA_VERSION);
    insertMeta.run("senses", includeSenses ? "1" : "0");
    insertMeta.run("built_at", new Date().toISOString());

    const insertLemma = db.prepare("INSERT INTO lemmas (lemma) VALUES (?)");
    const insertLemmaPos = db.prepare(
      "INSERT INTO lemma_pos (lemma, pos, senses) VALUES (?, ?, ?)",
    );
    const insertVariation = db.prepare(
      "INSERT OR IGNORE INTO variations (form) VALUES (?)",
    );
    const insertVariationLemma = db.prepare(
      "INSERT OR IGNORE INTO variation_lemmas (form, lemma) VALUES (?, ?)",
    );

    const INSERT_CHUNK = 2000;
    let lemmaDone = 0;

    const writeLemmas = db.transaction((slice) => {
      for (const lemma of slice) {
        insertLemma.run(lemma);
        const entries = lemmaIndex.get(lemma) ?? [];
        entries.sort((a, b) => a.pos.localeCompare(b.pos));

        for (const { pos, key } of entries) {
          const bucket = normalizeBucket(map.get(key));
          const sensesJson =
            includeSenses && bucket.senses.length
              ? JSON.stringify(bucket.senses)
              : null;
          insertLemmaPos.run(lemma, pos, sensesJson);

          for (const form of bucket.forms) {
            insertVariation.run(form);
            insertVariationLemma.run(form, lemma);
          }

          // Free this root+POS as soon as it is persisted.
          map.delete(key);
        }

        lemmaIndex.delete(lemma);
      }
    });

    for (let i = 0; i < lemmas.length; i += INSERT_CHUNK) {
      const slice = lemmas.slice(i, i + INSERT_CHUNK);
      writeLemmas(slice);
      lemmaDone = Math.min(i + INSERT_CHUNK, lemmas.length);
      onProgress?.(
        `Wrote ${lemmaDone.toLocaleString("en-US")} / ${lemmaCount.toLocaleString("en-US")} lemmas…`,
      );
    }

    map.clear();
    lemmaIndex.clear();

    variationCount = Number(
      db.prepare("SELECT COUNT(*) AS c FROM variations").get()?.c ?? 0,
    );
    onProgress?.(
      `Wrote ${variationCount.toLocaleString("en-US")} variations…`,
    );

    onProgress?.("ANALYZE + VACUUM…");
    db.exec("ANALYZE");
    db.pragma("journal_mode = DELETE");
    db.exec("VACUUM");
  } finally {
    db.close();
  }

  return {
    lemmaCount,
    variationCount,
    sqlitePath,
  };
}
