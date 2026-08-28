#!/usr/bin/env node
/**
 * Stage 1: stream wiktextract raw dumps → one combined JSONL per language.
 *
 * Usage:
 *   node filter-lang-dumps.js [options]
 *
 * Reads wiktionary-raw/<edition>.jsonl.gz (once per edition) and appends
 * matching entries into wiktionary-lang/<lang>.jsonl.gz.
 * Entries are partitioned by lang_code only — raw JSON lines are copied
 * unchanged. Morphology filtering happens in stage 2 (build-morphology.js).
 *
 * Options:
 *   --lang CODE     Target language (repeatable; default: cs de en es fr it pl pt)
 *   --edition CODE  Only this raw dump (repeatable; default: all *.jsonl.gz)
 *   --limit N       Stop after N scanned lines per edition (smoke test)
 *   --help
 */

import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createGzip, createGunzip } from "node:zlib";
import { finished } from "node:stream/promises";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAW_DIR = resolve(__dirname, "wiktionary-raw");
const LANG_DIR = resolve(__dirname, "wiktionary-lang");

const DEFAULT_LANGS = ["cs", "de", "en", "es", "fr", "it", "pl", "pt"];

/** Overwrite a single stderr status line (no scroll spam / no wrap). */
function writeStatus(msg) {
  const cols = process.stderr.columns || 80;
  const max = Math.max(24, cols - 1);
  let line = String(msg).replace(/[\r\n\t]+/g, " ");
  if (line.length > max) line = `${line.slice(0, max - 1)}…`;
  process.stderr.write(`\r${line}\x1b[K`);
}

function parseArgs(argv) {
  const opts = {
    langs: [],
    editions: [],
    limit: Infinity,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--lang") {
      const code = String(argv[++i] ?? "").toLowerCase();
      if (!code) throw new Error("--lang expects a language code");
      opts.langs.push(code);
    } else if (arg === "--edition") {
      const code = String(argv[++i] ?? "").toLowerCase();
      if (!code) throw new Error("--edition expects an edition code");
      opts.editions.push(code);
    } else if (arg === "--limit") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) {
        throw new Error("--limit expects a positive number");
      }
      opts.limit = n;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  if (!opts.langs.length) opts.langs = [...DEFAULT_LANGS];
  return opts;
}

function printHelp() {
  const script = basename(fileURLToPath(import.meta.url));
  console.log(`Usage: node ${script} [options]

Partition wiktionary-raw/*.jsonl.gz by lang_code into one combined file per
language: wiktionary-lang/<lang>.jsonl.gz (raw lines unchanged).

Options:
  --lang CODE     Target language (repeatable; default: ${DEFAULT_LANGS.join(" ")})
  --edition CODE  Only this raw dump (repeatable; default: all)
  --limit N       Stop after N scanned lines per edition (smoke test)
  --help          Show this help`);
}

function resolveEditions(explicit) {
  if (explicit.length) {
    return explicit.map((code) => {
      const path = resolve(RAW_DIR, `${code}.jsonl.gz`);
      if (!existsSync(path)) {
        throw new Error(`Raw dump not found: ${path}`);
      }
      return { code, path };
    });
  }

  if (!existsSync(RAW_DIR)) {
    throw new Error(`Raw dump directory not found: ${RAW_DIR}`);
  }

  return readdirSync(RAW_DIR)
    .filter((name) => name.endsWith(".jsonl.gz"))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({
      code: basename(name, ".jsonl.gz"),
      path: resolve(RAW_DIR, name),
    }));
}

/** Read lang_code without re-serializing the entry. */
function langCodeOf(line) {
  try {
    const entry = JSON.parse(line);
    return String(entry.lang_code ?? "").toLowerCase();
  } catch {
    return null;
  }
}

function openLineStream(filePath) {
  const raw = createReadStream(filePath, { highWaterMark: 1024 * 1024 });
  const source = filePath.endsWith(".gz") ? raw.pipe(createGunzip()) : raw;
  return createInterface({ input: source, crlfDelay: Infinity });
}

function openLangWriters(langs) {
  mkdirSync(LANG_DIR, { recursive: true });
  /** @type {Map<string, { gzip: import("node:zlib").Gzip, file: import("node:fs").WriteStream, count: number, path: string }>} */
  const writers = new Map();

  for (const lang of langs) {
    const outPath = resolve(LANG_DIR, `${lang}.jsonl.gz`);
    const gzip = createGzip({ level: 6 });
    const file = createWriteStream(outPath);
    gzip.pipe(file);
    writers.set(lang, { gzip, file, count: 0, path: outPath });
  }

  return writers;
}

async function closeWriters(writers) {
  const closes = [];
  for (const w of writers.values()) {
    w.gzip.end();
    closes.push(finished(w.file));
  }
  await Promise.all(closes);
}

async function filterEdition({ code, path }, langSet, writers, limit) {
  const rl = openLineStream(path);

  let scanned = 0;
  let malformed = 0;
  let matched = 0;
  let lastProgressAt = 0;
  const started = Date.now();
  /** @type {Map<string, number>} */
  const perLang = new Map();

  const printProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastProgressAt < 500) return;
    lastProgressAt = now;
    const elapsedSec = (now - started) / 1000;
    const rate = elapsedSec > 0 ? Math.round(scanned / elapsedSec) : 0;
    writeStatus(
      `[${code}] scanned ${scanned.toLocaleString("en-US")} · matched ${matched.toLocaleString("en-US")} · ${rate.toLocaleString("en-US")}/s · ${elapsedSec.toFixed(1)}s`,
    );
  };

  try {
    for await (const line of rl) {
      if (!line) continue;
      scanned++;

      const lang = langCodeOf(line);
      if (lang === null) {
        malformed++;
      } else if (langSet.has(lang)) {
        const writer = writers.get(lang);
        const ok = writer.gzip.write(`${line}\n`);
        writer.count++;
        matched++;
        perLang.set(lang, (perLang.get(lang) ?? 0) + 1);
        if (!ok) {
          await new Promise((resolveDrain) => writer.gzip.once("drain", resolveDrain));
        }
      }

      printProgress();
      if (scanned >= limit) break;
    }
  } finally {
    rl.close();
    rl.input?.destroy?.();
  }

  printProgress(true);
  process.stderr.write("\n");
  if (malformed) {
    console.error(`  Skipped ${malformed.toLocaleString("en-US")} malformed line(s)`);
  }
  for (const lang of [...perLang.keys()].sort()) {
    console.error(`  +${perLang.get(lang).toLocaleString("en-US")} ${lang}`);
  }

  return { scanned, matched };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const editions = resolveEditions(opts.editions);
  if (!editions.length) {
    throw new Error(`No .jsonl.gz dumps in ${RAW_DIR}`);
  }

  console.error(`Raw: ${RAW_DIR}`);
  console.error(`Out: ${LANG_DIR}/<lang>.jsonl.gz`);
  console.error(`Langs: ${opts.langs.join(", ")}`);
  console.error(`Editions (${editions.length}): ${editions.map((e) => e.code).join(", ")}`);
  if (Number.isFinite(opts.limit)) console.error(`Scan limit: ${opts.limit} per edition`);
  console.error("");

  const langSet = new Set(opts.langs);
  const writers = openLangWriters(opts.langs);
  let totalScanned = 0;
  let totalMatched = 0;
  const wallStart = Date.now();

  try {
    for (const edition of editions) {
      console.error(`Filtering: ${edition.path}`);
      const { scanned, matched } = await filterEdition(
        edition,
        langSet,
        writers,
        opts.limit,
      );
      totalScanned += scanned;
      totalMatched += matched;
    }
  } finally {
    await closeWriters(writers);
  }

  console.error("");
  for (const [lang, w] of writers) {
    if (w.count === 0) {
      unlinkSync(w.path);
      console.error(`${lang}: (empty — removed)`);
    } else {
      console.error(`${lang}: ${w.count.toLocaleString("en-US")} → ${w.path}`);
    }
  }

  const elapsedSec = (Date.now() - wallStart) / 1000;
  console.error("");
  console.error(
    `Done. Scanned ${totalScanned.toLocaleString("en-US")} · matched ${totalMatched.toLocaleString("en-US")} · ${elapsedSec.toFixed(1)}s`,
  );
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
