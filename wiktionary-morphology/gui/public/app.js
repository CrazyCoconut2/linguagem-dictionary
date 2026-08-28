const PAGE_SIZE = 48;
const DEBOUNCE_MS = 250;

const POS_KEYS = {
  noun: "noun",
  verb: "verb",
  adjective: "adjective",
  adj: "adj",
  adverb: "adverb",
  adv: "adv",
  pronoun: "pronoun",
  preposition: "preposition",
  prep: "prep",
  conjunction: "conjunction",
  interjection: "interjection",
  article: "article",
  determiner: "determiner",
  particle: "particle",
  numeral: "numeral",
  num: "num",
  "proper noun": "proper-noun",
  name: "name",
  phrase: "phrase",
};

const els = {
  lang: document.getElementById("lang"),
  search: document.getElementById("search"),
  filterBtn: document.getElementById("filterBtn"),
  filterPopover: document.getElementById("filterPopover"),
  filterCount: document.getElementById("filterCount"),
  sortBtn: document.getElementById("sortBtn"),
  sortPopover: document.getElementById("sortPopover"),
  listCount: document.getElementById("listCount"),
  pageInfo: document.getElementById("pageInfo"),
  prevBtn: document.getElementById("prevBtn"),
  nextBtn: document.getElementById("nextBtn"),
  empty: document.getElementById("empty"),
  masonry: document.getElementById("masonry"),
  grid: document.getElementById("grid"),
  main: document.getElementById("main"),
  modal: document.getElementById("modal"),
  modalLemma: document.getElementById("modalLemma"),
  modalPos: document.getElementById("modalPos"),
  modalMeta: document.getElementById("modalMeta"),
  modalSenses: document.getElementById("modalSenses"),
  modalSensesBody: document.getElementById("modalSensesBody"),
  modalRaw: document.getElementById("modalRaw"),
  modalRawBody: document.getElementById("modalRawBody"),
  modalForms: document.getElementById("modalForms"),
};

/** @type {string[]} */
let availablePos = [];
/** @type {string[]} */
let posFilters = [];
let sort = "lemma-asc";
let page = 1;
let total = 0;
let totalPages = 1;
let query = "";
let debounceTimer = 0;
/** @type {AbortController | null} */
let loadAbort = null;

async function fetchJson(url, signal) {
  const res = await fetch(url, { signal });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function posCssClass(pos) {
  const base = pos.replace(/\s+\d+$/, "").trim().toLowerCase();
  const key = POS_KEYS[base] ?? "other";
  return `pos-pill--${key}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Highlight case-insensitive needle occurrences. */
function highlightHtml(text, needle) {
  const raw = String(text);
  const n = needle.trim();
  if (!n) return escapeHtml(raw);
  const lower = raw.toLowerCase();
  const needleLower = n.toLowerCase();
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const at = lower.indexOf(needleLower, i);
    if (at < 0) {
      out += escapeHtml(raw.slice(i));
      break;
    }
    out += escapeHtml(raw.slice(i, at));
    out += `<mark class="dict-hit">${escapeHtml(
      raw.slice(at, at + n.length),
    )}</mark>`;
    i = at + n.length;
  }
  return out;
}

function highlightNeedle() {
  const q = query.trim();
  if (!q || q.startsWith("*") || q.startsWith("(")) return "";
  return q.replace(/\*+$/, "");
}

function distributeToColumns(items, columnCount) {
  const count = Math.max(1, Math.min(Math.floor(columnCount), items.length || 1));
  const columns = Array.from({ length: count }, () => []);
  items.forEach((item, index) => {
    columns[index % count].push(item);
  });
  return columns;
}

function masonryColumnCount(widthPx) {
  const minColumnPx = 150;
  const gapPx = 6;
  const maxColumns = 6;
  if (!Number.isFinite(widthPx) || widthPx <= 0) return 2;
  const fitted = Math.floor((widthPx + gapPx) / (minColumnPx + gapPx));
  return Math.max(1, Math.min(maxColumns, Math.max(1, fitted)));
}

function syncUrl() {
  const params = new URLSearchParams();
  if (els.lang.value) params.set("lang", els.lang.value);
  if (query) params.set("q", query);
  if (posFilters.length) params.set("pos", posFilters.join(","));
  if (sort !== "lemma-asc") params.set("sort", sort);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  const lang = params.get("lang");
  if (lang) els.lang.value = lang;
  query = params.get("q")?.trim() ?? "";
  els.search.value = query;
  posFilters = (params.get("pos") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const s = params.get("sort");
  sort = s === "lemma-desc" ? "lemma-desc" : "lemma-asc";
  const p = Number(params.get("page") ?? 1);
  page = Number.isFinite(p) && p > 0 ? Math.floor(p) : 1;
}

function updateFilterUi() {
  const n = posFilters.length;
  els.filterCount.hidden = n === 0;
  els.filterCount.textContent = String(n);
  els.filterBtn.classList.toggle("active", n > 0);
  renderFilterPopover();
}

function renderFilterPopover() {
  const parts = [
    `<p class="popover-section-label">Part of speech</p>`,
    `<button type="button" class="popover-option${
      posFilters.length === 0 ? " selected" : ""
    }" data-pos-all>All</button>`,
  ];
  for (const pos of availablePos) {
    const selected = posFilters.includes(pos);
    parts.push(
      `<button type="button" class="popover-option${
        selected ? " selected" : ""
      }" data-pos="${escapeHtml(pos)}">${escapeHtml(pos)}</button>`,
    );
  }
  els.filterPopover.innerHTML = parts.join("");
}

function updateSortUi() {
  for (const btn of els.sortPopover.querySelectorAll("[data-sort]")) {
    btn.classList.toggle("selected", btn.dataset.sort === sort);
  }
  els.sortBtn.classList.toggle("active", sort !== "lemma-asc");
}

function updatePager() {
  const label =
    total === 0
      ? "0 entries"
      : `${total.toLocaleString("en-US")} ${total === 1 ? "entry" : "entries"}`;
  els.listCount.textContent = label;
  els.pageInfo.textContent = `${page} / ${Math.max(1, totalPages)}`;
  els.prevBtn.disabled = page <= 1;
  els.nextBtn.disabled = page >= totalPages || total === 0;
}

function showEmpty(title, hint = "") {
  els.masonry.hidden = true;
  els.empty.hidden = false;
  els.empty.innerHTML = `<p class="empty-title">${escapeHtml(title)}</p>${
    hint ? `<p class="empty-hint">${escapeHtml(hint)}</p>` : ""
  }`;
}

function renderTiles(entries) {
  if (!entries.length) {
    showEmpty("No entries match", "Try a different search term or POS filter.");
    return;
  }

  els.empty.hidden = true;
  els.masonry.hidden = false;

  const cols = distributeToColumns(
    entries,
    masonryColumnCount(els.main.clientWidth),
  );
  const needle = highlightNeedle();

  els.grid.innerHTML = cols
    .map((column) => {
      const tiles = column
        .map((entry) => {
          const formsHtml =
            entry.formCount === 0
              ? `<p class="tile-description">No surface forms</p>`
              : `<p class="tile-description">${entry.previewForms
                  .map(
                    (form, i) =>
                      `<span class="dict-form">${highlightHtml(
                        form,
                        needle,
                      )}</span>${
                        i < entry.previewForms.length - 1
                          ? `<span class="dict-form-sep"> · </span>`
                          : ""
                      }`,
                  )
                  .join("")}${
                  entry.formCount > entry.previewForms.length
                    ? `<span class="dict-form-more"> · +${
                        entry.formCount - entry.previewForms.length
                      }</span>`
                    : ""
                }</p>`;

          const pills = entry.poses
            .map(
              (pos) =>
                `<button type="button" class="pos-pill ${posCssClass(pos)}${
                  posFilters.includes(pos) ? " selected" : ""
                }" data-pos-toggle="${escapeHtml(pos)}">${escapeHtml(
                  pos,
                )}</button>`,
            )
            .join("");

          const stats =
            entry.formCount > 0
              ? `<span class="tile-stats">${entry.formCount} ${
                  entry.formCount === 1 ? "form" : "forms"
                }</span>`
              : "";

          return `<article class="entry-tile entry-tile--clickable" role="button" tabindex="0" data-lemma="${escapeHtml(
            entry.lemma,
          )}">
            <div class="tile-body">
              <header class="tile-header">
                <h2 class="tile-title">${highlightHtml(entry.lemma, needle)}</h2>
              </header>
              ${formsHtml}
            </div>
            <footer class="tile-foot">
              <div class="pos-pills">${pills}</div>
              ${stats}
            </footer>
          </article>`;
        })
        .join("");
      return `<div class="entry-col">${tiles}</div>`;
    })
    .join("");
}

async function loadPage() {
  const lang = els.lang.value;
  if (!lang) {
    showEmpty("No packs", "Run e.g. npm run build:pt");
    return;
  }

  if (loadAbort) loadAbort.abort();
  loadAbort = new AbortController();
  const { signal } = loadAbort;

  syncUrl();
  updateFilterUi();
  updateSortUi();

  const params = new URLSearchParams({
    lang,
    page: String(page),
    pageSize: String(PAGE_SIZE),
    sort,
  });
  if (query) params.set("q", query);
  if (posFilters.length) params.set("pos", posFilters.join(","));

  try {
    const data = await fetchJson(`/api/dictionary?${params}`, signal);
    total = data.total;
    totalPages = data.totalPages || 1;
    updatePager();
    renderTiles(data.entries || []);
    els.main.scrollTop = 0;
  } catch (err) {
    if (err?.name === "AbortError") return;
    showEmpty("Error", err.message || String(err));
    total = 0;
    totalPages = 1;
    updatePager();
  }
}

async function loadLanguages() {
  const data = await fetchJson("/api/languages");
  els.lang.innerHTML = "";
  if (!data.languages.length) {
    showEmpty("No .sqlite packs found", "Run e.g. npm run build:pt");
    return;
  }
  for (const item of data.languages) {
    const opt = document.createElement("option");
    opt.value = item.lang;
    opt.textContent = item.version ? `${item.lang} · ${item.version}` : item.lang;
    els.lang.appendChild(opt);
  }
  readUrl();
  if (![...els.lang.options].some((o) => o.value === els.lang.value)) {
    els.lang.selectedIndex = 0;
  }
  await loadPos();
  await loadPage();
}

async function loadPos() {
  const lang = els.lang.value;
  availablePos = [];
  if (!lang) return;
  const data = await fetchJson(`/api/pos?lang=${encodeURIComponent(lang)}`);
  availablePos = data.pos || [];
  updateFilterUi();
}

function togglePosFilter(pos) {
  if (posFilters.includes(pos)) {
    posFilters = posFilters.filter((p) => p !== pos);
  } else {
    posFilters = [...posFilters, pos];
  }
  page = 1;
  loadPage();
}

function closePopovers() {
  els.filterPopover.hidden = true;
  els.sortPopover.hidden = true;
  els.filterBtn.setAttribute("aria-expanded", "false");
  els.sortBtn.setAttribute("aria-expanded", "false");
}

async function openLemma(lemma) {
  const lang = els.lang.value;
  els.modalLemma.textContent = lemma;
  els.modalPos.innerHTML = "";
  els.modalMeta.textContent = "Loading…";
  els.modalSenses.hidden = true;
  els.modalSensesBody.innerHTML = "";
  els.modalRaw.hidden = true;
  els.modalRaw.open = false;
  els.modalRawBody.textContent = "";
  els.modalForms.innerHTML = "";
  els.modal.showModal();

  try {
    const params = new URLSearchParams({
      lang,
      kind: "lemma",
      token: lemma,
    });
    const data = await fetchJson(`/api/detail?${params}`);
    const detail = data.detail;
    els.modalLemma.textContent = detail.lemma;
    els.modalPos.innerHTML = (detail.poses || [])
      .map(
        (pos) =>
          `<button type="button" class="pos-pill ${posCssClass(pos)}${
            posFilters.includes(pos) ? " selected" : ""
          }" data-pos-toggle="${escapeHtml(pos)}">${escapeHtml(pos)}</button>`,
      )
      .join("");
    const n = detail.forms?.length ?? 0;
    const senseCount = countSenses(detail);
    const senseLabel =
      senseCount === 0
        ? "no definitions"
        : `${senseCount} ${senseCount === 1 ? "definition" : "definitions"}`;
    els.modalMeta.textContent = `${n} ${n === 1 ? "form" : "forms"} · ${senseLabel}`;

    const sensesHtml = renderSenses(detail);
    if (sensesHtml) {
      els.modalSensesBody.innerHTML = sensesHtml;
      els.modalSenses.hidden = false;
    }

    const rawSenses = detail.sensesByPos || {};
    if (Object.keys(rawSenses).length) {
      els.modalRawBody.textContent = JSON.stringify(rawSenses, null, 2);
      els.modalRaw.hidden = false;
    }

    els.modalForms.innerHTML = (detail.forms || [])
      .map((form) => `<li>${escapeHtml(form)}</li>`)
      .join("");
  } catch (err) {
    els.modalMeta.textContent = err.message || String(err);
  }
}

/**
 * @param {{ sensesByPos?: Record<string, Array<{ glosses: string[], examples?: string[] }>> }} detail
 */
function countSenses(detail) {
  let n = 0;
  for (const senses of Object.values(detail.sensesByPos || {})) {
    n += senses?.length ?? 0;
  }
  return n;
}

/**
 * @param {{ poses?: string[], sensesByPos?: Record<string, object[]> }} detail
 */
function renderSenses(detail) {
  const byPos = detail.sensesByPos || {};
  const poses = detail.poses || [];
  const posKeys = [
    ...poses,
    ...Object.keys(byPos).filter((p) => !poses.includes(p)),
  ];
  const blocks = [];

  for (const pos of posKeys) {
    const senses = byPos[pos];
    if (!senses?.length) continue;

    const senseHtml = senses
      .map((sense, i) => {
        const glosses = (sense.glosses || [])
          .map((g) => `<p class="sense-gloss">${escapeHtml(g)}</p>`)
          .join("");
        const meta = renderSenseMeta(sense);
        const relations = renderSenseRelations(sense);
        const examples = (sense.examples || [])
          .map((ex) => renderSenseExample(ex))
          .filter(Boolean)
          .join("");
        return `<article class="sense-item">
          <div class="sense-index" aria-hidden="true">${i + 1}</div>
          <div class="sense-body">
            ${glosses}
            ${meta}
            ${relations}
            ${
              examples
                ? `<ul class="sense-examples">${examples}</ul>`
                : ""
            }
          </div>
        </article>`;
      })
      .join("");

    blocks.push(
      `<section class="sense-pos-block">
        <h4 class="sense-pos-label">${escapeHtml(pos)}</h4>
        ${senseHtml}
      </section>`,
    );
  }

  return blocks.join("");
}

/**
 * @param {string | { text?: string, tags?: string[] }} ex
 */
function renderSenseExample(ex) {
  const text = typeof ex === "string" ? ex : ex?.text;
  if (!text) return "";
  const tags = typeof ex === "object" && Array.isArray(ex.tags) ? ex.tags : [];
  const tagHtml = tags.length
    ? `<span class="sense-example-tags">${tags
        .map((t) => `<span class="sense-chip">${escapeHtml(t)}</span>`)
        .join("")}</span>`
    : "";
  return `<li class="sense-example"><q>${escapeHtml(text)}</q>${tagHtml}</li>`;
}

/**
 * Tags / topics / qualifier chips for one sense (includes regional labels).
 * @param {object} sense
 */
function renderSenseMeta(sense) {
  const chips = [];
  if (sense.qualifier) {
    chips.push(
      `<span class="sense-chip sense-chip--qualifier">${escapeHtml(sense.qualifier)}</span>`,
    );
  }
  for (const tag of sense.tags || []) {
    chips.push(`<span class="sense-chip">${escapeHtml(tag)}</span>`);
  }
  for (const tag of sense.raw_tags || []) {
    chips.push(`<span class="sense-chip">${escapeHtml(tag)}</span>`);
  }
  for (const topic of sense.topics || []) {
    chips.push(
      `<span class="sense-chip sense-chip--topic">${escapeHtml(topic)}</span>`,
    );
  }
  if (!chips.length) return "";
  return `<div class="sense-meta">${chips.join("")}</div>`;
}

/**
 * Synonyms / antonyms / related lists.
 * @param {object} sense
 */
function renderSenseRelations(sense) {
  const rows = [
    ["Synonyms", sense.synonyms],
    ["Antonyms", sense.antonyms],
    ["Related", sense.related],
  ].filter(([, words]) => Array.isArray(words) && words.length);

  if (!rows.length) return "";

  return `<dl class="sense-relations">${rows
    .map(
      ([label, words]) => `<div class="sense-relation">
        <dt>${escapeHtml(label)}</dt>
        <dd>${words.map((w) => escapeHtml(w)).join(", ")}</dd>
      </div>`,
    )
    .join("")}</dl>`;
}

els.search.addEventListener("input", () => {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    query = els.search.value.trim();
    page = 1;
    loadPage();
  }, DEBOUNCE_MS);
});

els.lang.addEventListener("change", async () => {
  page = 1;
  posFilters = [];
  await loadPos();
  await loadPage();
});

els.filterBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = els.filterPopover.hidden;
  closePopovers();
  if (open) {
    els.filterPopover.hidden = false;
    els.filterBtn.setAttribute("aria-expanded", "true");
  }
});

els.sortBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const open = els.sortPopover.hidden;
  closePopovers();
  if (open) {
    els.sortPopover.hidden = false;
    els.sortBtn.setAttribute("aria-expanded", "true");
  }
});

els.filterPopover.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.hasAttribute("data-pos-all")) {
    posFilters = [];
  } else if (btn.dataset.pos) {
    togglePosFilter(btn.dataset.pos);
    return;
  }
  page = 1;
  closePopovers();
  loadPage();
});

els.sortPopover.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-sort]");
  if (!btn) return;
  sort = btn.dataset.sort === "lemma-desc" ? "lemma-desc" : "lemma-asc";
  page = 1;
  closePopovers();
  loadPage();
});

document.addEventListener("click", () => closePopovers());

els.prevBtn.addEventListener("click", () => {
  if (page <= 1) return;
  page -= 1;
  loadPage();
});

els.nextBtn.addEventListener("click", () => {
  if (page >= totalPages) return;
  page += 1;
  loadPage();
});

els.grid.addEventListener("click", (e) => {
  const posBtn = e.target.closest("[data-pos-toggle]");
  if (posBtn) {
    e.stopPropagation();
    togglePosFilter(posBtn.dataset.posToggle);
    return;
  }
  const tile = e.target.closest("[data-lemma]");
  if (tile) openLemma(tile.dataset.lemma);
});

els.grid.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const tile = e.target.closest("[data-lemma]");
  if (!tile) return;
  e.preventDefault();
  openLemma(tile.dataset.lemma);
});

els.modalPos.addEventListener("click", (e) => {
  const posBtn = e.target.closest("[data-pos-toggle]");
  if (!posBtn) return;
  togglePosFilter(posBtn.dataset.posToggle);
});

let resizeTimer = 0;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!els.masonry.hidden) loadPage();
  }, 150);
});

loadLanguages().catch((err) => {
  showEmpty("Error", err.message || String(err));
});
