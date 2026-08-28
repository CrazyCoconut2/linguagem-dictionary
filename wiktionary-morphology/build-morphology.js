#!/usr/bin/env node
/**
 * Stage 2: stream a language dump, aggregate morphology into a pack.
 *
 * Usage:
 *   node build-morphology.js [file ...] --lang en --version 1.0.0 [options]
 *
 * Writes a SQLite morphology DB:
 *   wiktionary-morphology-packs/<lang>.sqlite
 *
 * Pack version is stored in meta.version inside the database (not the filename).
 *
 * By default (no files), reads wiktionary-lang/<lang>.jsonl.gz — the combined
 * language dump from filter-lang-dumps.js.
 *
 * Options:
 *   --lang CODE     Language code (required)
 *   --version VER   Pack version written to meta (required), e.g. 1.0.0
 *   --out [PATH]    Output path (default: wiktionary-morphology-packs/<lang>.sqlite)
 *   --workers N     Worker threads (default: CPU count)
 *   --limit N       Stop after N scanned lines (smoke test)
 *   --all-sense-editions  Keep glosses from every Wiktionary edition (default: native edition only)
 *   --help
 */

import { createReadStream, existsSync } from "node:fs";
import { cpus } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createGunzip } from "node:zlib";
import { senseDedupeKey } from "./morphology.js";
import { packLang, stripSenseKeys, validateVersion, writeSqlitePack } from "./sqlite-pack.js";

const BATCH_SIZE = 250;
const __dirname = dirname(fileURLToPath(import.meta.url));
const LANG_DIR = resolve(__dirname, "wiktionary-lang");
const PACKS_DIR = resolve(__dirname, "wiktionary-morphology-packs");
const WORKER_PATH = resolve(__dirname, "build-morphology-worker.js");

/** Overwrite a single stderr status line (no scroll spam / no wrap). */
function writeStatus(msg) {
  const cols = process.stderr.columns || 80;
  const max = Math.max(24, cols - 1);
  let line = String(msg).replace(/[\r\n\t]+/g, " ");
  if (line.length > max) line = `${line.slice(0, max - 1)}…`;
  process.stderr.write(`\r${line}\x1b[K`);
}

function defaultDumpPath(lang) {
  return resolve(LANG_DIR, `${lang}.jsonl.gz`);
}

function resolveDumpFiles(lang, explicitFiles) {
  if (explicitFiles.length) {
    return explicitFiles.map((f) => resolve(f));
  }

  const path = defaultDumpPath(lang);
  if (!existsSync(path)) {
    throw new Error(
      `Language dump not found: ${path}\nRun: node filter-lang-dumps.js --lang ${lang}`,
    );
  }
  return [path];
}

function defaultPackPath(lang) {
  return resolve(PACKS_DIR, `${packLang(lang)}.sqlite`);
}

function parseArgs(argv) {
  const opts = {
    files: [],
    lang: null,
    version: null,
    out: null,
    workers: cpus().length || 4,
    limit: Infinity,
    nativeSensesOnly: true,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--lang") {
      opts.lang = String(argv[++i] ?? "").toLowerCase();
      if (!opts.lang) throw new Error("--lang expects a language code");
    } else if (arg === "--version") {
      opts.version = String(argv[++i] ?? "").trim();
      if (!opts.version) throw new Error("--version expects a value");
    } else if (arg === "--out") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        opts.out = resolve(argv[++i]);
      } else {
        opts.out = true; // resolve after --lang is known
      }
    } else if (arg === "--workers") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error("--workers expects a positive number");
      }
      opts.workers = Math.floor(n);
    } else if (arg === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error("--limit expects a positive number");
      }
      opts.limit = n;
    } else if (arg === "--all-sense-editions") {
      opts.nativeSensesOnly = false;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      opts.files.push(arg);
    }
  }

  return opts;
}

function printHelp() {
  const script = basename(fileURLToPath(import.meta.url));
  console.log(`Usage: node ${script} [file ...] --lang CODE --version VER [options]

Aggregate morphology into a SQLite pack:
  wiktionary-morphology-packs/<lang>.sqlite

Pack version is stored in meta.version (not the filename).

With no files, streams wiktionary-lang/<lang>.jsonl.gz (combined language dump
from filter-lang-dumps.js).

Options:
  --lang CODE     Language code (required), e.g. en
  --version VER   Pack version written to meta (required), e.g. 1.0.0
  --out [PATH]    Output path (default: wiktionary-morphology-packs/<lang>.sqlite)
  --workers N     Worker threads (default: CPU count)
  --limit N       Stop after N scanned lines (smoke test)
  --all-sense-editions  Keep glosses from every edition (default: native only)
  --help          Show this help`);
}

function openLineStream(filePath) {
  const raw = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  const source = filePath.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  return createInterface({ input: source, crlfDelay: Infinity });
}

function createWorkerPool(size) {
  const workers = [];
  const free = [];
  const waiters = [];

  for (let i = 0; i < size; i++) {
    const worker = new Worker(WORKER_PATH);
    workers.push(worker);
    free.push(worker);
  }

  function acquire() {
    if (free.length) return Promise.resolve(free.pop());
    return new Promise((resolveAcquire) => waiters.push(resolveAcquire));
  }

  function release(worker) {
    const waiter = waiters.shift();
    if (waiter) waiter(worker);
    else free.push(worker);
  }

  async function run(lines, opts) {
    const worker = await acquire();
    try {
      return await new Promise((resolveRun, reject) => {
        const onMessage = (result) => {
          cleanup();
          resolveRun(result);
        };
        const onError = (err) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          worker.off("message", onMessage);
          worker.off("error", onError);
        };
        worker.on("message", onMessage);
        worker.on("error", onError);
        worker.postMessage({ lines, opts });
      });
    } finally {
      release(worker);
    }
  }

  async function close() {
    await Promise.all(workers.map((w) => w.terminate()));
  }

  return { run, close, size };
}

/**
 * @param {Map<string, { forms: Set<string>, senses: Array<{ glosses: string[], examples?: string[] }>, senseKeys: Set<string> }>} map
 * @param {Array<{ r: string, p: string, forms: string[], senses?: Array<{ glosses: string[], examples?: string[] }> }>} deltas
 */
function mergeDeltas(map, deltas) {
  for (const { r, p, forms, senses } of deltas) {
    const key = `${r}\0${p}`;
    let bucket = map.get(key);
    if (!bucket) {
      bucket = { forms: new Set(), senses: [], senseKeys: new Set() };
      map.set(key, bucket);
    }
    for (const form of forms) {
      if (form && form !== r) bucket.forms.add(form);
    }
    for (const sense of senses ?? []) {
      const sk = senseDedupeKey(sense);
      if (bucket.senseKeys.has(sk)) continue;
      bucket.senseKeys.add(sk);
      bucket.senses.push(sense);
    }
  }
}

/**
 * Stream one dump into `map`. Returns whether the scan limit was hit.
 * `state` tracks shared counters across dumps when --limit is set.
 */
async function scanDump(filePath, { pool, map, filterOpts, state, maxInFlight }) {
  if (!existsSync(filePath)) {
    throw new Error(`Dump not found: ${filePath}`);
  }

  const rl = openLineStream(filePath);
  const inFlight = new Set();
  let stop = false;
  let fileRead = 0;
  const rootsBefore = map.size;

  const printProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - state.lastProgressAt < 500) return;
    state.lastProgressAt = now;
    const elapsedSec = (now - state.started) / 1000;
    const rate = elapsedSec > 0 ? Math.round(state.scanned / elapsedSec) : 0;
    writeStatus(
      `[${state.fileLabel}] read ${state.read.toLocaleString("en-US")} · parsed ${state.scanned.toLocaleString("en-US")} · roots ${map.size.toLocaleString("en-US")} · ${rate.toLocaleString("en-US")}/s · ${elapsedSec.toFixed(1)}s`,
    );
  };

  const handleResult = (result) => {
    state.scanned += result.scanned;
    if (result.malformed) {
      console.error(`\nSkipped ${result.malformed} malformed JSON line(s) in a batch`);
    }
    mergeDeltas(map, result.deltas);
    printProgress();
    if (state.scanned >= state.limit) stop = true;
  };

  const launchBatch = (batch) => {
    const task = pool.run(batch, filterOpts).then(handleResult);
    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
    return task;
  };

  try {
    let batch = [];

    for await (const line of rl) {
      if (stop) break;
      if (!line) continue;

      fileRead++;
      state.read++;
      batch.push(line);
      printProgress();

      if (batch.length < BATCH_SIZE) continue;

      while (inFlight.size >= maxInFlight) {
        printProgress();
        await Promise.race(inFlight);
        if (stop) break;
      }
      if (stop) break;

      launchBatch(batch);
      batch = [];
    }

    if (!stop && batch.length) {
      if (Number.isFinite(state.limit) && state.scanned < state.limit) {
        const remaining = state.limit - state.scanned;
        if (batch.length > remaining) batch = batch.slice(0, remaining);
      }
      if (batch.length) launchBatch(batch);
    }

    while (inFlight.size) {
      printProgress();
      await Promise.race(inFlight);
    }
  } finally {
    rl.close();
    rl.input?.destroy?.();
  }

  printProgress(true);
  process.stderr.write("\n");
  console.error(
    `  +${(map.size - rootsBefore).toLocaleString("en-US")} new root+POS from ${basename(filePath)} (file lines: ${fileRead.toLocaleString("en-US")})`,
  );

  return stop || state.scanned >= state.limit;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }
  if (!opts.lang) {
    throw new Error("--lang is required");
  }
  if (!opts.version) {
    throw new Error("--version is required");
  }
  packLang(opts.lang);
  validateVersion(opts.version);

  const outPath =
    opts.out === true || opts.out == null
      ? defaultPackPath(opts.lang)
      : opts.out;

  const files = resolveDumpFiles(opts.lang, opts.files);
  for (const filePath of files) {
    if (!existsSync(filePath)) {
      throw new Error(`Dump not found: ${filePath}`);
    }
  }

  console.error(`Lang: ${opts.lang}`);
  console.error(`Version: ${opts.version}`);
  console.error(`Output: ${outPath}`);
  console.error(`Workers: ${opts.workers}`);
  console.error(
    `Sense editions: ${
      opts.nativeSensesOnly
        ? "native only (same-language Wiktionary)"
        : "all (--all-sense-editions)"
    }`,
  );
  console.error(`Dumps (${files.length}), first-come / add missing variations:`);
  for (const [i, filePath] of files.entries()) {
    const tag = i === 0 ? "primary" : "enrich";
    console.error(`  [${tag}] ${filePath}`);
  }
  if (Number.isFinite(opts.limit)) console.error(`Scan limit: ${opts.limit}`);
  console.error("");

  const pool = createWorkerPool(opts.workers);
  /** @type {Map<string, { forms: Set<string>, senses: Array<{ glosses: string[], examples?: string[] }>, senseKeys: Set<string> }>} */
  const map = new Map();
  const filterOpts = {
    lang: opts.lang,
    nativeSensesOnly: opts.nativeSensesOnly,
  };
  const maxInFlight = opts.workers * 2;
  const state = {
    read: 0,
    scanned: 0,
    limit: opts.limit,
    started: Date.now(),
    lastProgressAt: 0,
    fileLabel: "",
  };

  try {
    for (const filePath of files) {
      state.fileLabel = opts.lang;
      console.error(`Streaming: ${filePath}`);
      const hitLimit = await scanDump(filePath, {
        pool,
        map,
        filterOpts,
        state,
        maxInFlight,
      });
      if (hitLimit) {
        console.error("Scan limit reached; skipping remaining dumps.");
        break;
      }
    }
  } finally {
    await pool.close();
  }

  // Drop empty buckets (no forms and no senses)
  for (const [key, bucket] of map) {
    if (!bucket.forms.size && !bucket.senses.length) map.delete(key);
  }
  stripSenseKeys(map);

  console.error(
    `Aggregated ${map.size.toLocaleString("en-US")} term+POS entries. Writing SQLite pack…`,
  );
  const result = await writeSqlitePack(outPath, map, {
    lang: opts.lang,
    version: opts.version,
    onProgress: writeStatus,
  });
  process.stderr.write("\n");
  console.error(
    `Done. Wrote ${result.lemmaCount.toLocaleString("en-US")} lemmas, ${result.variationCount.toLocaleString("en-US")} variations`,
  );
  console.error(`  ${result.sqlitePath}`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
