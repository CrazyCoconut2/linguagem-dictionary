/**
 * Pattern search over a morphology SQLite pack.
 *
 * Supported patterns (prefix-oriented, like linguagem dictionary):
 *   word     exact
 *   re*      prefix
 *   (a|b)    top-level OR of exact / prefix
 */

import Database from "better-sqlite3";

/** @typedef {'exact' | 'prefix'} PatternMode */
/** @typedef {'all' | 'lemmas' | 'variations'} SearchScope */

/**
 * @typedef {object} ParsedAtom
 * @property {PatternMode} mode
 * @property {string} value
 */

/**
 * Escape LIKE metacharacters; use `\` as ESCAPE char.
 * @param {string} s
 */
export function escapeLike(s) {
  return s.replace(/([\\%_])/g, "\\$1");
}

/**
 * Normalize a token value (trim + collapse internal whitespace).
 * @param {string} s
 */
export function normalizeToken(s) {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * Parse one atom: exact or prefix only.
 * Suffix / contains patterns are not supported (no FTS / reverse indexes).
 * @param {string} raw
 * @returns {ParsedAtom | null}
 */
export function parseAtom(raw) {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Reject suffix / contains (*er, *ill*)
  if (trimmed.startsWith("*")) return null;

  if (trimmed.endsWith("*") && trimmed.length > 1) {
    const value = normalizeToken(trimmed.slice(0, -1));
    return value ? { mode: "prefix", value } : null;
  }
  const value = normalizeToken(trimmed);
  return value ? { mode: "exact", value } : null;
}

/**
 * Parse pattern into OR'd atoms. Supports `(a|b|c)` or a single atom.
 * @param {string} pattern
 * @returns {ParsedAtom[]}
 */
export function parsePattern(pattern) {
  const trimmed = pattern.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("(") && trimmed.endsWith(")")) {
    const inner = trimmed.slice(1, -1);
    if (!inner.includes("(") && !inner.includes(")")) {
      const parts = inner.split("|");
      /** @type {ParsedAtom[]} */
      const atoms = [];
      for (const part of parts) {
        const atom = parseAtom(part);
        if (atom) atoms.push(atom);
      }
      return atoms;
    }
  }

  const atom = parseAtom(trimmed);
  return atom ? [atom] : [];
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
 * @param {SearchScope} scope
 * @param {'lemma' | 'variation'} kind
 */
function scopeAllows(scope, kind) {
  if (scope === "all") return true;
  if (scope === "lemmas") return kind === "lemma";
  if (scope === "variations") return kind === "variation";
  return false;
}

/**
 * Collect matching tokens for one atom (no pagination).
 * @param {import('better-sqlite3').Database} db
 * @param {ParsedAtom} atom
 * @param {SearchScope} scope
 * @param {string[]} poses
 * @param {number} hardCap
 * @returns {{ token: string, kind: 'lemma' | 'variation' }[]}
 */
function matchAtom(db, atom, scope, poses, hardCap) {
  /** @type {{ token: string, kind: 'lemma' | 'variation' }[]} */
  const out = [];
  const wantPos = poses.length > 0;
  const posPlaceholders = poses.map(() => "?").join(",");

  const lemmaPosFilter = wantPos
    ? `AND EXISTS (
         SELECT 1 FROM lemma_pos lp
         WHERE lp.lemma = lemmas.lemma AND lp.pos IN (${posPlaceholders})
       )`
    : "";

  const variationPosFilter = wantPos
    ? `AND EXISTS (
         SELECT 1 FROM variation_lemmas vl
         JOIN lemma_pos lp ON lp.lemma = vl.lemma
         WHERE vl.form = variations.form AND lp.pos IN (${posPlaceholders})
       )`
    : "";

  const pushLemmaRows = (rows) => {
    for (const row of rows) {
      out.push({ token: row.lemma, kind: "lemma" });
      if (out.length >= hardCap) return true;
    }
    return false;
  };

  const pushFormRows = (rows) => {
    for (const row of rows) {
      out.push({ token: row.form, kind: "variation" });
      if (out.length >= hardCap) return true;
    }
    return false;
  };

  if (atom.mode === "exact") {
    if (scopeAllows(scope, "lemma")) {
      const sql = `SELECT lemma FROM lemmas WHERE lemma = ? ${lemmaPosFilter} LIMIT ?`;
      const params = wantPos
        ? [atom.value, ...poses, hardCap]
        : [atom.value, hardCap];
      if (pushLemmaRows(db.prepare(sql).all(...params))) return out;
    }
    if (scopeAllows(scope, "variation")) {
      const sql = `SELECT form FROM variations WHERE form = ? ${variationPosFilter} LIMIT ?`;
      const params = wantPos
        ? [atom.value, ...poses, hardCap]
        : [atom.value, hardCap];
      pushFormRows(db.prepare(sql).all(...params));
    }
    return out;
  }

  if (atom.mode === "prefix") {
    const like = `${escapeLike(atom.value)}%`;
    if (scopeAllows(scope, "lemma")) {
      const sql = `SELECT lemma FROM lemmas WHERE lemma LIKE ? ESCAPE '\\' ${lemmaPosFilter}
                   ORDER BY lemma LIMIT ?`;
      const params = wantPos
        ? [like, ...poses, hardCap]
        : [like, hardCap];
      if (pushLemmaRows(db.prepare(sql).all(...params))) return out;
    }
    if (scopeAllows(scope, "variation")) {
      const remaining = hardCap - out.length;
      const sql = `SELECT form FROM variations WHERE form LIKE ? ESCAPE '\\' ${variationPosFilter}
                   ORDER BY form LIMIT ?`;
      const params = wantPos
        ? [like, ...poses, remaining]
        : [like, remaining];
      pushFormRows(db.prepare(sql).all(...params));
    }
  }

  return out;
}

/**
 * Enrich a token hit with POS / linked lemmas.
 * @param {import('better-sqlite3').Database} db
 * @param {{ token: string, kind: 'lemma' | 'variation' }} hit
 */
function enrichHit(db, hit) {
  if (hit.kind === "lemma") {
    const poses = db
      .prepare(
        "SELECT pos FROM lemma_pos WHERE lemma = ? ORDER BY pos COLLATE NOCASE",
      )
      .all(hit.token)
      .map((r) => r.pos);
    return { token: hit.token, kind: hit.kind, poses, lemmas: [hit.token] };
  }
  const lemmas = db
    .prepare(
      "SELECT lemma FROM variation_lemmas WHERE form = ? ORDER BY lemma COLLATE NOCASE",
    )
    .all(hit.token)
    .map((r) => r.lemma);
  const poses = db
    .prepare(
      `SELECT DISTINCT lp.pos AS pos
       FROM variation_lemmas vl
       JOIN lemma_pos lp ON lp.lemma = vl.lemma
       WHERE vl.form = ?
       ORDER BY lp.pos COLLATE NOCASE`,
    )
    .all(hit.token)
    .map((r) => r.pos);
  return { token: hit.token, kind: hit.kind, poses, lemmas };
}

/**
 * Search morphology pack by pattern.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   pattern: string,
 *   scope?: SearchScope,
 *   pos?: string[],
 *   limit?: number,
 *   offset?: number,
 * }} opts
 */
export function searchMorphology(db, opts) {
  const pattern = opts.pattern ?? "";
  const scope = opts.scope ?? "all";
  const poses = (opts.pos ?? []).filter(Boolean);
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  const offset = Math.max(0, opts.offset ?? 0);

  const atoms = parsePattern(pattern);
  if (!atoms.length) {
    return { pattern, scope, atoms: [], total: 0, results: [] };
  }

  // Cap per-atom collection high enough for merge + pagination
  const hardCap = Math.min(offset + limit + 5000, 20000);

  /** @type {Map<string, { token: string, kind: 'lemma' | 'variation' }>} */
  const merged = new Map();
  for (const atom of atoms) {
    const hits = matchAtom(db, atom, scope, poses, hardCap);
    for (const hit of hits) {
      const key = `${hit.kind}\0${hit.token}`;
      if (!merged.has(key)) merged.set(key, hit);
    }
  }

  const sorted = [...merged.values()].sort((a, b) => {
    const c = a.token.localeCompare(b.token);
    if (c !== 0) return c;
    return a.kind.localeCompare(b.kind);
  });

  const total = sorted.length;
  const page = sorted.slice(offset, offset + limit).map((hit) => enrichHit(db, hit));

  return {
    pattern,
    scope,
    atoms,
    total,
    offset,
    limit,
    results: page,
  };
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
 * Forms for tile preview: prefix matches first, then remaining, capped.
 * @param {string[]} forms
 * @param {string} prefix
 * @param {number} limit
 */
export function previewForms(forms, prefix, limit = FORM_PREVIEW_LIMIT) {
  const p = prefix.trim();
  if (limit <= 0) return [];
  if (!p) return forms.slice(0, limit);

  const matched = [];
  const rest = [];
  for (const form of forms) {
    if (form.startsWith(p)) matched.push(form);
    else rest.push(form);
  }
  return [...matched, ...rest].slice(0, limit);
}

/**
 * True when pattern uses OR syntax (not plain dictionary prefix text).
 * @param {string} pattern
 */
export function isAdvancedPattern(pattern) {
  const t = pattern.trim();
  return t.startsWith("(") && t.includes("|");
}

/**
 * Normalize GUI query to search pattern.
 * Plain text → prefix (`cas` → `cas*`) like linguagem dictionary.
 * Suffix / contains (`*er`, `*ill*`) are unsupported and yield no pattern.
 * @param {string} query
 */
export function dictionaryPatternFromQuery(query) {
  const q = query.trim();
  if (!q) return "";
  if (q.startsWith("*")) return "";
  if (isAdvancedPattern(q)) return q;
  if (q.endsWith("*")) return q;
  return `${q}*`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} lemma
 * @param {string} highlightPrefix
 */
function lemmaTile(db, lemma, highlightPrefix) {
  const detail = getLemmaDetail(db, lemma);
  if (!detail) return null;
  const formCount = detail.forms.length;
  return {
    lemma: detail.lemma,
    poses: detail.poses,
    formCount,
    previewForms: previewForms(detail.forms, highlightPrefix, FORM_PREVIEW_LIMIT),
  };
}

/**
 * Browse / search lemmas like the linguagem dictionary page.
 *
 * Empty query → A–Z browse. Plain text → prefix (lemma ∪ form→lemma).
 * Explicit `re*` and `(a|b)` OR also supported.
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
  const highlightPrefix = (() => {
    const q = query.trim();
    if (!q || q.startsWith("*") || q.startsWith("(")) return "";
    return q.replace(/\*+$/, "");
  })();

  /** @type {string[]} */
  let lemmas;

  if (!query) {
    // Browse all lemmas (optional POS filter)
    if (poses.length) {
      const ph = poses.map(() => "?").join(",");
      const totalRow = db
        .prepare(
          `SELECT COUNT(DISTINCT lp.lemma) AS n
           FROM lemma_pos lp
           WHERE lp.pos IN (${ph})`,
        )
        .get(...poses);
      const total = totalRow?.n ?? 0;
      const rows = db
        .prepare(
          `SELECT DISTINCT lp.lemma AS lemma
           FROM lemma_pos lp
           WHERE lp.pos IN (${ph})
           ORDER BY lp.lemma COLLATE NOCASE ${orderSql}
           LIMIT ? OFFSET ?`,
        )
        .all(...poses, pageSize, offset);
      lemmas = rows.map((r) => r.lemma);
      const entries = lemmas
        .map((lemma) => lemmaTile(db, lemma, highlightPrefix))
        .filter(Boolean);
      return {
        query,
        pattern: "",
        pos: poses,
        sort,
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        entries,
      };
    }

    const totalRow = db.prepare("SELECT COUNT(*) AS n FROM lemmas").get();
    const total = totalRow?.n ?? 0;
    const rows = db
      .prepare(
        `SELECT lemma FROM lemmas
         ORDER BY lemma COLLATE NOCASE ${orderSql}
         LIMIT ? OFFSET ?`,
      )
      .all(pageSize, offset);
    lemmas = rows.map((r) => r.lemma);
    const entries = lemmas
      .map((lemma) => lemmaTile(db, lemma, highlightPrefix))
      .filter(Boolean);
    return {
      query,
      pattern: "",
      pos: poses,
      sort,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize) || 1),
      entries,
    };
  }

  // Search → unique lemmas (dictionary-style union)
  const pattern = dictionaryPatternFromQuery(query);
  const hardCap = 20000;
  const atoms = parsePattern(pattern);
  /** @type {Set<string>} */
  const lemmaSet = new Set();

  for (const atom of atoms) {
    const hits = matchAtom(db, atom, "all", poses, hardCap);
    for (const hit of hits) {
      if (hit.kind === "lemma") {
        lemmaSet.add(hit.token);
      } else {
        const linked = db
          .prepare(
            "SELECT lemma FROM variation_lemmas WHERE form = ?",
          )
          .all(hit.token);
        for (const row of linked) lemmaSet.add(row.lemma);
      }
    }
  }

  lemmas = [...lemmaSet].sort((a, b) => {
    const c = a.localeCompare(b, undefined, { sensitivity: "base" });
    return sort === "lemma-desc" ? -c : c;
  });

  // Re-apply POS filter on lemmas when search returned form hits
  if (poses.length) {
    const want = new Set(poses);
    lemmas = lemmas.filter((lemma) => {
      const rows = db
        .prepare("SELECT pos FROM lemma_pos WHERE lemma = ?")
        .all(lemma);
      return rows.some((r) => want.has(r.pos));
    });
  }

  const total = lemmas.length;
  const pageLemmas = lemmas.slice(offset, offset + pageSize);
  const entries = pageLemmas
    .map((lemma) => lemmaTile(db, lemma, highlightPrefix))
    .filter(Boolean);

  return {
    query,
    pattern,
    atoms,
    pos: poses,
    sort,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize) || 1),
    entries,
  };
}

