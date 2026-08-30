#!/usr/bin/env node
/**
 * Stage 2 for every language: run build-morphology.js once per lang.
 *
 * Usage:
 *   node build-all.js [options]
 *   npm run build
 *
 * Options:
 *   --lang CODE     Only this language (repeatable; default: all with a dump,
 *                   else cs de en es fr it pl pt)
 *   --workers N     Forwarded to build-morphology.js
 *   --limit N       Forwarded to build-morphology.js
 *   --all-sense-editions  Forwarded to build-morphology.js
 *   --help
 */

import { existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LANG_DIR = resolve(__dirname, "wiktionary-lang");
const BUILD_PATH = resolve(__dirname, "build-morphology.js");
const DEFAULT_LANGS = ["cs", "de", "en", "es", "fr", "it", "pl", "pt"];

function parseArgs(argv) {
  const opts = { langs: [], forward: [], help: false };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--lang") {
      const code = String(argv[++i] ?? "").toLowerCase();
      if (!code) throw new Error("--lang expects a language code");
      opts.langs.push(code);
    } else if (arg === "--workers" || arg === "--limit") {
      const value = argv[++i];
      if (value == null || value.startsWith("-")) {
        throw new Error(`${arg} expects a value`);
      }
      opts.forward.push(arg, value);
    } else if (arg === "--all-sense-editions") {
      opts.forward.push(arg);
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

Build morphology packs for all languages (sequential).

Options:
  --lang CODE     Only this language (repeatable)
  --workers N     Forwarded to build-morphology.js
  --limit N       Forwarded to build-morphology.js
  --all-sense-editions  Forwarded to build-morphology.js
  --help          Show this help`);
}

function resolveLangs(explicit) {
  if (explicit.length) return [...new Set(explicit)];

  if (existsSync(LANG_DIR)) {
    const fromDir = readdirSync(LANG_DIR)
      .filter((name) => name.endsWith(".jsonl.gz"))
      .map((name) => basename(name, ".jsonl.gz"))
      .sort((a, b) => a.localeCompare(b));
    if (fromDir.length) return fromDir;
  }

  return [...DEFAULT_LANGS];
}

function runBuild(lang, forward) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(
      process.execPath,
      [BUILD_PATH, "--lang", lang, ...forward],
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`build --lang ${lang} killed by ${signal}`));
      } else if (code !== 0) {
        reject(new Error(`build --lang ${lang} failed (exit ${code})`));
      } else {
        resolveRun();
      }
    });
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const langs = resolveLangs(opts.langs);
  console.error(`Building ${langs.length} language(s): ${langs.join(", ")}`);
  console.error("");

  const wallStart = Date.now();
  for (let i = 0; i < langs.length; i++) {
    const lang = langs[i];
    console.error(`═══ [${i + 1}/${langs.length}] ${lang} ═══`);
    await runBuild(lang, opts.forward);
    console.error("");
  }

  const elapsedSec = (Date.now() - wallStart) / 1000;
  console.error(`All done (${langs.length} langs) in ${elapsedSec.toFixed(1)}s`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
