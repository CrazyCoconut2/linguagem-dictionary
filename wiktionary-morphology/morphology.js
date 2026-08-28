/** Shared morphology extract helpers for build workers. */

const NON_FORM_TAGS = new Set([
  "table-tags",
  "inflection-template",
  "multiword-construction",
]);

/**
 * POS values dropped entirely (not useful for lemma ↔ form morphology).
 * unknown, num, onomatopoeia, character, phrase, symbol, proverb, punct/punctuation
 */
export const SKIP_POS = new Set([
  "unknown",
  "num",
  "onomatopoeia",
  "character",
  "phrase",
  "symbol",
  "proverb",
  "punct",
  "punctuation",
]);

/**
 * Wiktionary edition's native label for `entry.lang` when defining that language.
 * Used so es packs keep Español glosses, not Espagnol / Spagnolo / Spanish / …
 * (lang dumps merge every edition by lang_code).
 */
export const NATIVE_LANG_LABEL = {
  cs: "čeština",
  de: "Deutsch",
  en: "English",
  es: "Español",
  fr: "Français",
  it: "Italiano",
  pl: "język polski",
  pt: "Português",
};

/**
 * True when this entry's glosses are written in the pack language
 * (came from that language's Wiktionary edition).
 */
export function isNativeGlossEntry(entry, lang) {
  const expected = NATIVE_LANG_LABEL[String(lang ?? "").toLowerCase()];
  if (!expected) return true; // unknown lang: keep senses
  return String(entry?.lang ?? "") === expected;
}

/**
 * Drop roots that contain punctuation (\p{P}), symbols (\p{S}), or '!'.
 * Covers # " ! as punctuation, and $ ` + etc. as symbols.
 * Hyphen and apostrophes are allowed (mother-in-law, l'homme).
 * Multiword spaces, letters, and digits are kept.
 * Examples dropped: #MeToo, $DEITY, "R" slur, hello!, `num`
 * Examples kept: rain cats and dogs, dictionary, l'homme
 */
const ROOT_BAD = /[\p{P}\p{S}!]/u;
const ROOT_ALLOWED_PUNCT = /['’ʼ-]/g;

function rootHasBadChars(r) {
  return ROOT_BAD.test(r.replace(ROOT_ALLOWED_PUNCT, ""));
}

export function isProperNoun(entry) {
  if (String(entry.pos ?? "").toLowerCase() === "name") return true;

  const tagLists = [entry.tags ?? []];
  for (const sense of entry.senses ?? []) tagLists.push(sense.tags ?? []);

  for (const tags of tagLists) {
    for (const tag of tags) {
      const t = String(tag).toLowerCase();
      if (t === "proper-noun" || t === "proper noun" || t === "surname" || t === "given-name") {
        return true;
      }
    }
  }

  return false;
}

/**
 * Strip parenthetical notes from a variation surface form.
 * e.g. "casas (plural)" → "casas", "foo (bar) (baz)" → "foo"
 * Nested parentheses are peeled until none remain.
 */
export function stripParentheticals(form) {
  let s = String(form ?? "");
  let prev;
  do {
    prev = s;
    s = s.replace(/\s*\([^()]*\)/g, "");
  } while (s !== prev);
  return s.replace(/\s+/g, " ").trim();
}

/** True if this forms[] entry is a real surface form, not table/template noise. */
export function isSurfaceForm(f) {
  const form = f?.form;
  if (!form || typeof form !== "string") return false;

  for (const tag of f.tags ?? []) {
    if (NON_FORM_TAGS.has(String(tag).toLowerCase())) return false;
  }

  // e.g. "avoir + past participle", "present indicative of avoir + past participle"
  if (form.includes(" + ")) return false;

  return true;
}

/**
 * Lemmas this entry is listed as a form / inflection / alternative of.
 * Non-empty ⇒ do not treat `entry.word` as its own morphology root.
 */
export function inflectionOfLemmas(entry) {
  /** @type {string[]} */
  const lemmas = [];
  for (const sense of entry.senses ?? []) {
    for (const kind of ["form_of", "inflection_of", "alt_of"]) {
      for (const ref of sense[kind] ?? []) {
        const lemma = String(ref?.word ?? ref ?? "").trim();
        if (lemma) lemmas.push(lemma);
      }
    }
  }
  return lemmas;
}

/**
 * Pull word strings from synonym / antonym / related-style lists.
 * @param {unknown} list
 * @returns {string[]}
 */
function compactWordList(list) {
  if (!Array.isArray(list)) return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const word =
      typeof item === "string"
        ? item.trim()
        : String(item?.word ?? "").trim();
    if (!word || seen.has(word)) continue;
    seen.add(word);
    out.push(word);
  }
  return out;
}

/**
 * Compact string tags / topics lists.
 * @param {unknown} list
 * @returns {string[]}
 */
function compactStringList(list) {
  if (!Array.isArray(list)) return [];
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const text = String(item ?? "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

/**
 * Compact sense for pack storage: glosses, examples (+ their tags), and metadata.
 * Example tags often carry regional labels (Brazil, Portugal, …).
 * @returns {object | null}
 */
export function compactSense(sense) {
  const glosses = [];
  for (const g of sense?.glosses ?? []) {
    const text = String(g ?? "").trim();
    if (text) glosses.push(text);
  }
  if (!glosses.length) return null;

  /** @type {Array<string | { text: string, tags?: string[] }>} */
  const examples = [];
  for (const ex of sense?.examples ?? []) {
    if (typeof ex === "string") {
      const text = ex.trim();
      if (text) examples.push(text);
      continue;
    }
    const text = String(ex?.text ?? "").trim();
    if (!text) continue;
    const tags = [
      ...compactStringList(ex?.tags),
      ...compactStringList(ex?.raw_tags),
    ];
    if (tags.length) examples.push({ text, tags });
    else examples.push(text);
  }

  /** @type {Record<string, unknown>} */
  const out = { glosses };
  if (examples.length) out.examples = examples;

  // Sense-level tags include regional labels (Brazil, Portugal, …) and grammar
  const tags = [
    ...compactStringList(sense?.tags),
    ...compactStringList(sense?.raw_tags),
  ];
  if (tags.length) out.tags = tags;

  const topics = compactStringList(sense?.topics);
  if (topics.length) out.topics = topics;

  const qualifier = String(sense?.qualifier ?? "").trim();
  if (qualifier) out.qualifier = qualifier;

  const synonyms = compactWordList(sense?.synonyms);
  if (synonyms.length) out.synonyms = synonyms;

  const antonyms = compactWordList(sense?.antonyms);
  if (antonyms.length) out.antonyms = antonyms;

  const related = compactWordList(sense?.related);
  if (related.length) out.related = related;

  return out;
}

/** Stable key for sense dedupe. */
export function senseDedupeKey(sense) {
  return JSON.stringify({
    glosses: sense.glosses,
    examples: sense.examples ?? [],
    tags: sense.tags ?? [],
    topics: sense.topics ?? [],
    qualifier: sense.qualifier ?? "",
    synonyms: sense.synonyms ?? [],
    antonyms: sense.antonyms ?? [],
    related: sense.related ?? [],
  });
}

/**
 * Extract compact morphology deltas from one wiktextract entry.
 * @param {object} entry
 * @param {string} lang
 * @param {{ includeSenses?: boolean, nativeSensesOnly?: boolean }} [opts]
 * @returns {Array<{ r: string, p: string, forms: string[], senses: Array<object> }>}
 */
export function extractDeltas(entry, lang, opts = {}) {
  const includeSenses = opts.includeSenses !== false;
  const nativeSensesOnly = opts.nativeSensesOnly !== false;

  if (lang && String(entry.lang_code ?? "").toLowerCase() !== lang) {
    return [];
  }
  if (isProperNoun(entry)) return [];

  const pos = entry.pos;
  if (!pos) return [];
  if (SKIP_POS.has(String(pos).toLowerCase())) return [];

  /** @type {Map<string, { forms: Set<string>, senses: Array<object>, senseKeys: Set<string> }>} */
  const local = new Map();

  const ensure = (r, p) => {
    if (!r || !p) return null;
    if (rootHasBadChars(r)) return null;
    const key = `${r}\0${p}`;
    let bucket = local.get(key);
    if (!bucket) {
      bucket = { forms: new Set(), senses: [], senseKeys: new Set() };
      local.set(key, bucket);
    }
    return bucket;
  };

  const addForm = (r, p, form) => {
    const bucket = ensure(r, p);
    if (!bucket || !form) return;
    const cleaned = stripParentheticals(form);
    if (!cleaned || cleaned === r) return;
    bucket.forms.add(cleaned);
  };

  const addSenses = (r, p, senses) => {
    const bucket = ensure(r, p);
    if (!bucket) return;
    for (const sense of senses) {
      const key = senseDedupeKey(sense);
      if (bucket.senseKeys.has(key)) continue;
      bucket.senseKeys.add(key);
      bucket.senses.push(sense);
    }
  };

  const word = entry.word;
  if (!word) return [];

  const lemmas = inflectionOfLemmas(entry);

  // form_of / inflection_of / alt_of pages are only variations of those
  // lemmas — never their own roots (avoids abacoraría etc. as separate r).
  if (lemmas.length > 0) {
    for (const lemma of lemmas) {
      addForm(lemma, pos, word);
    }
  } else {
    for (const f of entry.forms ?? []) {
      if (isSurfaceForm(f)) addForm(word, pos, f.form);
    }

    const keepSenses =
      includeSenses &&
      (!nativeSensesOnly || isNativeGlossEntry(entry, lang));
    if (keepSenses) {
      /** @type {object[]} */
      const senses = [];
      for (const sense of entry.senses ?? []) {
        const compact = compactSense(sense);
        if (compact) senses.push(compact);
      }
      if (senses.length) addSenses(word, pos, senses);
    }
  }

  const out = [];
  for (const [key, bucket] of local) {
    // Drop empty buckets (no forms and no senses)
    if (!bucket.forms.size && !bucket.senses.length) continue;
    const sep = key.indexOf("\0");
    out.push({
      r: key.slice(0, sep),
      p: key.slice(sep + 1),
      forms: [...bucket.forms],
      senses: bucket.senses,
    });
  }
  return out;
}

/**
 * Process a batch of JSONL lines into deltas.
 * @returns {{ scanned: number, malformed: number, deltas: Array<{ r: string, p: string, forms: string[], senses: Array<{ glosses: string[], examples?: string[] }> }> }}
 */
export function processLines(lines, opts) {
  let scanned = 0;
  let malformed = 0;
  const deltas = [];
  const extractOpts = {
    includeSenses: opts?.includeSenses !== false,
    nativeSensesOnly: opts?.nativeSensesOnly !== false,
  };

  for (const line of lines) {
    if (!line) continue;
    scanned++;

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }

    for (const delta of extractDeltas(entry, opts.lang, extractOpts)) {
      deltas.push(delta);
    }
  }

  return { scanned, malformed, deltas };
}
