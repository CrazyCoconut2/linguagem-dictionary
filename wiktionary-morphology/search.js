/**
 * Pack lookup matching the production dictionary API:
 *   empty     A–Z browse
 *   exact     lemma or form equals q
 *   contains  lemma or form contains q
 *
 * No prefix / suffix / OR pattern language.
 */

import Database from "better-sqlite3";

/**
 * Escape LIKE metacharacters; use `\` as ESCAPE char.
 * @param {string} s
 */
export function escapeLike(s) {
  return s.replace(/([\\%_])/g, "\\$1");
}

/**
 * Open a morphology pack DB (read-only).
 * @param {string} sqlitePath
 */
export function openPack(sqlitePath) {
  return new Database(sqlitePath, { readonly: true, fileMustExist: true });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} key
 */
export function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return row?.value ?? null;
}

/**
 * List distinct POS values in the pack.
 * @param {import('better-sqlite3').Database} db
 */
export function listPos(db) {
  return db
    .prepare("SELECT DISTINCT pos FROM lemma_pos ORDER BY pos COLLATE NOCASE")
    .all()
    .map((r) => r.pos);
}

/**
 * Lemma detail: POS + all forms.
 * @param {import('better-sqlite3').Database} db
 * @param {string} lemma
 */
export function getLemmaDetail(db, lemma) {
  const row = db
    .prepare("SELECT lemma FROM lemmas WHERE lemma = ?")
    .get(lemma);
  if (!row) return null;

  const hasSensesCol = db
    .prepare("PRAGMA table_info(lemma_pos)")
    .all()
    .some((c) => c.name === "senses");

  const posRows = hasSensesCol
    ? db
        .prepare(
          "SELECT pos, senses FROM lemma_pos WHERE lemma = ? ORDER BY pos COLLATE NOCASE",
        )
        .all(lemma)
    : db
        .prepare(
          "SELECT pos FROM lemma_pos WHERE lemma = ? ORDER BY pos COLLATE NOCASE",
        )
        .all(lemma);

  const poses = posRows.map((r) => r.pos);

  /** @type {Record<string, Array<{ glosses: string[], examples?: string[] }>>} */
  const sensesByPos = {};
  if (hasSensesCol) {
    for (const r of posRows) {
      if (!r.senses) continue;
      try {
        const parsed = JSON.parse(r.senses);
        if (Array.isArray(parsed) && parsed.length) {
          sensesByPos[r.pos] = parsed;
        }
      } catch {
        // ignore malformed JSON
      }
    }
  }

  const forms = db
    .prepare(
      `SELECT form FROM variation_lemmas
       WHERE lemma = ?
       ORDER BY form COLLATE NOCASE`,
    )
    .all(lemma)
    .map((r) => r.form);

  return { lemma, poses, forms, sensesByPos };
}

/**
 * Variation detail: lemmas + their POS.
 * @param {import('better-sqlite3').Database} db
 * @param {string} form
 */
export function getVariationDetail(db, form) {
  const row = db
    .prepare("SELECT form FROM variations WHERE form = ?")
    .get(form);
  if (!row) return null;

  const lemmas = db
    .prepare(
      "SELECT lemma FROM variation_lemmas WHERE form = ? ORDER BY lemma COLLATE NOCASE",
    )
    .all(form)
    .map((r) => r.lemma);

  const lemmaDetails = lemmas.map((lemma) => {
    const poses = db
      .prepare(
        "SELECT pos FROM lemma_pos WHERE lemma = ? ORDER BY pos COLLATE NOCASE",
      )
      .all(lemma)
      .map((r) => r.pos);
    return { lemma, poses };
  });

  return { form, lemmas: lemmaDetails };
}

const FORM_PREVIEW_LIMIT = 5;

/**
 * Forms for tile preview: contains matches first, then remaining, capped.
 * @param {string[]} forms
 * @param {string} needle
 * @param {number} limit
 */
export function previewForms(forms, needle, limit = FORM_PREVIEW_LIMIT) {
  const p = needle.trim().toLowerCase();
  if (limit <= 0) return [];
  if (!p) return forms.slice(0, limit);

  const matched = [];
  const rest = [];
  for (const form of forms) {
    if (form.toLowerCase().includes(p)) matched.push(form);
    else rest.push(form);
  }
  return [...matched, ...rest].slice(0, limit);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} lemma
 * @param {string} needle
 */
function lemmaTile(db, lemma, needle) {
  const detail = getLemmaDetail(db, lemma);
  if (!detail) return null;
  return {
    lemma: detail.lemma,
    poses: detail.poses,
    formCount: detail.forms.length,
    previewForms: previewForms(detail.forms, needle, FORM_PREVIEW_LIMIT),
  };
}

function posFilterSql(alias, poses) {
  if (!poses.length) return { sql: "", params: [] };
  const ph = poses.map(() => "?").join(",");
  return {
    sql: `AND EXISTS (
         SELECT 1 FROM lemma_pos lp
         WHERE lp.lemma = ${alias}.lemma AND lp.pos IN (${ph})
       )`,
    params: poses,
  };
}

/**
 * Browse / search lemmas like the dictionary page.
 *
 * Empty query → A–Z browse. Typed query → contains (lemma ∪ form→lemma).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   query?: string,
 *   pos?: string[],
 *   sort?: 'lemma-asc' | 'lemma-desc',
 *   pageSize?: number,
 *   page?: number,
 * }} opts
 */
export function queryDictionaryPage(db, opts) {
  const query = (opts.query ?? "").trim();
  const poses = (opts.pos ?? []).filter(Boolean);
  const sort = opts.sort === "lemma-desc" ? "lemma-desc" : "lemma-asc";
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? 48, 200));
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const offset = (page - 1) * pageSize;
  const orderSql = sort === "lemma-desc" ? "DESC" : "ASC";
  const pos = posFilterSql("hits", poses);

  const pageResult = (lemmas, total) => ({
    query,
    pos: poses,
    sort,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize) || 1),
    entries: lemmas.map((lemma) => lemmaTile(db, lemma, query)).filter(Boolean),
  });

  if (!query) {
    if (poses.length) {
      const ph = poses.map(() => "?").join(",");
      const total = db
        .prepare(
          `SELECT COUNT(DISTINCT lp.lemma) AS n
           FROM lemma_pos lp
           WHERE lp.pos IN (${ph})`,
        )
        .get(...poses)?.n ?? 0;
      const rows = db
        .prepare(
          `SELECT DISTINCT lp.lemma AS lemma
           FROM lemma_pos lp
           WHERE lp.pos IN (${ph})
           ORDER BY lp.lemma COLLATE NOCASE ${orderSql}
           LIMIT ? OFFSET ?`,
        )
        .all(...poses, pageSize, offset);
      return pageResult(
        rows.map((r) => r.lemma),
        total,
      );
    }

    const total = db.prepare("SELECT COUNT(*) AS n FROM lemmas").get()?.n ?? 0;
    const rows = db
      .prepare(
        `SELECT lemma FROM lemmas
         ORDER BY lemma COLLATE NOCASE ${orderSql}
         LIMIT ? OFFSET ?`,
      )
      .all(pageSize, offset);
    return pageResult(
      rows.map((r) => r.lemma),
      total,
    );
  }

  const like = `%${escapeLike(query)}%`;
  const hitsSql = `SELECT lemma FROM (
       SELECT lemma FROM lemmas WHERE lemma LIKE ? ESCAPE '\\'
       UNION
       SELECT vl.lemma AS lemma
       FROM variations v
       JOIN variation_lemmas vl ON vl.form = v.form
       WHERE v.form LIKE ? ESCAPE '\\'
     ) AS hits
     WHERE 1=1 ${pos.sql}`;

  const total =
    db
      .prepare(`SELECT COUNT(*) AS n FROM (${hitsSql}) AS counted`)
      .get(like, like, ...pos.params)?.n ?? 0;
  const rows = db
    .prepare(
      `${hitsSql}
       ORDER BY hits.lemma COLLATE NOCASE ${orderSql}
       LIMIT ? OFFSET ?`,
    )
    .all(like, like, ...pos.params, pageSize, offset);

  return pageResult(
    rows.map((r) => r.lemma),
    total,
  );
}
