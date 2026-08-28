#!/usr/bin/env node
/**
 * Print sizes of SQLite morphology packs.
 *
 * Usage:
 *   node size-packs.js
 *   node size-packs.js --lang en
 *   node size-packs.js --lang en --version 1.0.0
 *   node size-packs.js --dir wiktionary-morphology-packs
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePackFileName, readPackMeta } from "./sqlite-pack.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = resolve(__dirname, "wiktionary-morphology-packs");

function parseArgs(argv) {
  const opts = {
    langs: [],
    version: null,
    dir: DEFAULT_DIR,
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
    } else if (arg === "--version") {
      opts.version = String(argv[++i] ?? "").trim();
      if (!opts.version) throw new Error("--version expects a value");
    } else if (arg === "--dir") {
      opts.dir = resolve(String(argv[++i] ?? ""));
      if (!opts.dir) throw new Error("--dir expects a path");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return opts;
}

function printHelp() {
  const script = basename(fileURLToPath(import.meta.url));
  console.log(`Usage: node ${script} [options]

List SQLite pack sizes under wiktionary-morphology-packs/ (or --dir).
Filenames: <lang>.sqlite (version is in meta.version)

Options:
  --lang CODE     Only this language (repeatable)
  --version VER   Only packs whose meta.version matches
  --dir PATH      Pack directory (default: wiktionary-morphology-packs/)
  --help          Show this help`);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i++;
  } while (v >= 1024 && i < units.length - 1);
  const digits = v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

function listPackLangs(dir) {
  const langs = new Set();
  for (const name of readdirSync(dir)) {
    const parsed = parsePackFileName(name);
    if (parsed) langs.add(parsed.lang);
  }
  return [...langs].sort((a, b) => a.localeCompare(b));
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  if (!existsSync(opts.dir)) {
    console.error(`No pack directory: ${opts.dir}`);
    process.exit(1);
  }

  let langs = listPackLangs(opts.dir);
  if (opts.langs.length) {
    const want = new Set(opts.langs);
    langs = langs.filter((lang) => want.has(lang));
  }
  if (opts.version) {
    langs = langs.filter((lang) => {
      const sqlitePath = resolve(opts.dir, `${lang}.sqlite`);
      if (!existsSync(sqlitePath)) return false;
      try {
        return readPackMeta(sqlitePath, "version") === opts.version;
      } catch {
        return false;
      }
    });
  }

  if (!langs.length) {
    console.error(`No .sqlite packs in ${opts.dir}`);
    process.exit(1);
  }

  /** @type {{ name: string, size: number }[]} */
  const rows = [];
  let total = 0;
  let missing = 0;

  for (const lang of langs) {
    const sqliteName = `${lang}.sqlite`;
    const sqlitePath = resolve(opts.dir, sqliteName);
    if (!existsSync(sqlitePath)) {
      console.error(`missing  ${sqliteName}`);
      missing++;
      continue;
    }
    const size = statSync(sqlitePath).size;
    total += size;
    rows.push({ name: sqliteName, size });
  }

  if (!rows.length) {
    process.exit(1);
  }

  const nameWidth = Math.max(4, ...rows.map((r) => r.name.length));
  const sizeWidth = Math.max(4, ...rows.map((r) => formatBytes(r.size).length));

  for (const { name, size } of rows) {
    console.log(`${name.padEnd(nameWidth)}  ${formatBytes(size).padStart(sizeWidth)}`);
  }

  if (rows.length > 1) {
    console.log(
      `${"total".padEnd(nameWidth)}  ${formatBytes(total).padStart(sizeWidth)}  (${rows.length} files)`,
    );
  }

  if (missing) process.exit(1);
}

main();
