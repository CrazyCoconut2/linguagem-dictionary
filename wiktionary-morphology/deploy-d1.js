#!/usr/bin/env node
/**
 * Import morphology packs (.sqlite) into one Cloudflare D1 database per language.
 *
 * Runs wrangler against linguagem-dictionary-api (dict-<lang> bindings).
 *
 * Usage:
 *   npm run deploy:d1
 *   node deploy-d1.js --lang cs
 *   node deploy-d1.js --lang en --local
 *   node deploy-d1.js --dir wiktionary-morphology-packs --dry-run
 *
 * Prerequisites:
 *   sqlite3 CLI
 *   parent linguagem-dictionary-api with wrangler.toml database_ids filled in
 *   wrangler login (or CLOUDFLARE_API_TOKEN)
 */

import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parsePackFileName } from "./sqlite-pack.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = resolve(__dirname, "wiktionary-morphology-packs");
const DEFAULT_API_DIR = resolve(__dirname, "..");

function parseArgs(argv) {
  const opts = {
    langs: [],
    dir: DEFAULT_DIR,
    apiDir: process.env.DICTIONARY_API_DIR
      ? resolve(process.env.DICTIONARY_API_DIR)
      : DEFAULT_API_DIR,
    dryRun: false,
    local: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--lang") {
      const code = String(argv[++i] ?? "").toLowerCase();
      if (!code) throw new Error("--lang expects a language code");
      if (code !== "all") opts.langs.push(code);
    } else if (arg === "--dir") {
      opts.dir = resolve(String(argv[++i] ?? ""));
      if (!opts.dir) throw new Error("--dir expects a path");
    } else if (arg === "--api-dir") {
      opts.apiDir = resolve(String(argv[++i] ?? ""));
      if (!opts.apiDir) throw new Error("--api-dir expects a path");
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--local") {
      opts.local = true;
    } else if (arg === "--remote") {
      opts.local = false;
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

Dump <lang>.sqlite packs and import them into D1 (dict-<lang>) via wrangler.

Options:
  --lang CODE     Only this language (repeatable; "all" = every pack)
  --dir PATH      Pack directory (default: wiktionary-morphology-packs/)
  --api-dir PATH  linguagem-dictionary-api root (default: parent directory)
  --local         Import into wrangler local D1 (default: --remote)
  --remote        Import into Cloudflare D1
  --dry-run       List packs without importing
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

function listPackFiles(dir, langs) {
  if (!existsSync(dir)) {
    throw new Error(`No pack directory: ${dir}`);
  }

  /** @type {{ lang: string, path: string, size: number }[]} */
  let files = [];
  for (const name of readdirSync(dir)) {
    const parsed = parsePackFileName(name);
    if (!parsed) continue;
    const path = resolve(dir, name);
    files.push({
      lang: parsed.lang,
      path,
      size: statSync(path).size,
    });
  }

  if (langs.length) {
    const want = new Set(langs);
    files = files.filter((f) => want.has(f.lang));
  }

  files.sort((a, b) => a.lang.localeCompare(b.lang));

  if (!files.length) {
    throw new Error(`No matching .sqlite packs in ${dir}`);
  }
  return files;
}

/** Application tables only — `.dump` of the whole DB includes sqlite_stat* from ANALYZE. */
const D1_DUMP_TABLES = ["meta", "lemmas", "lemma_pos", "variations", "variation_lemmas"];

function skipDumpLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (trimmed === "BEGIN TRANSACTION;") return true;
  if (trimmed === "COMMIT;") return true;
  if (trimmed.startsWith("PRAGMA ")) return true;
  if (trimmed.startsWith("ANALYZE")) return true;
  if (trimmed.startsWith("CREATE TABLE _cf_KV")) return true;
  // Query-planner stats (sqlite_stat1/4) — D1 has no sqlite_stat4.
  if (/\bsqlite_stat\d+\b/.test(trimmed)) return true;
  return false;
}

function dumpSqliteToD1Sql(sqlitePath, dumpPath) {
  return new Promise((resolveDump, reject) => {
    const sqlite3 = spawn("sqlite3", [sqlitePath, `.dump ${D1_DUMP_TABLES.join(" ")}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = createWriteStream(dumpPath);
    let stderr = "";
    let buf = "";

    sqlite3.stderr.setEncoding("utf8");
    sqlite3.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    sqlite3.stdout.setEncoding("utf8");
    sqlite3.stdout.on("data", (chunk) => {
      buf += chunk;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (skipDumpLine(line)) continue;
        out.write(`${line}\n`);
      }
    });
    sqlite3.on("error", (err) => {
      out.destroy();
      reject(
        err.code === "ENOENT"
          ? new Error("sqlite3 CLI not found (needed to dump packs for D1)")
          : err,
      );
    });
    sqlite3.on("close", (code) => {
      if (buf && !skipDumpLine(buf)) out.write(`${buf}\n`);
      out.end();
      out.on("finish", () => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `sqlite3 .dump failed (exit ${code})`));
          return;
        }
        resolveDump();
      });
    });
  });
}

function wranglerExecute(apiDir, dbName, dumpPath, local) {
  const args = [
    "wrangler",
    "d1",
    "execute",
    dbName,
    local ? "--local" : "--remote",
    "--yes",
    "--file",
    dumpPath,
  ];
  const result = spawnSync("npx", args, { cwd: apiDir, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute ${dbName} failed (exit ${result.status ?? 1})`);
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const files = listPackFiles(opts.dir, opts.langs);
  const target = opts.local ? "local D1" : "remote D1";
  console.log(`api:    ${opts.apiDir}`);
  console.log(`target: ${target}`);
  console.log(`packs:  ${files.length}`);

  if (!existsSync(join(opts.apiDir, "wrangler.toml"))) {
    throw new Error(`No wrangler.toml in ${opts.apiDir} (pass --api-dir)`);
  }

  if (opts.dryRun) {
    for (const file of files) {
      console.log(`would import  dict-${file.lang}  (${formatBytes(file.size)})`);
    }
    return;
  }

  for (const file of files) {
    const dbName = `dict-${file.lang}`;
    const dir = mkdtempSync(join(tmpdir(), `d1-${file.lang}-`));
    const dumpPath = join(dir, `${file.lang}.sql`);
    try {
      console.log(`dump     ${file.lang}.sqlite  (${formatBytes(file.size)})`);
      await dumpSqliteToD1Sql(file.path, dumpPath);
      const dumpSize = statSync(dumpPath).size;
      console.log(`import   ${dbName}  (${formatBytes(dumpSize)} SQL)`);
      wranglerExecute(opts.apiDir, dbName, dumpPath, opts.local);
      console.log(`ok       ${dbName}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log(`done  ${files.length} pack(s) → ${target}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
