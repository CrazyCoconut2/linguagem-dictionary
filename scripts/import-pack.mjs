#!/usr/bin/env node
/**
 * Dump a morphology sqlite pack into D1-compatible SQL and import it.
 * Prefer `npm run deploy:d1` (wiktionary-morphology/) for the usual path.
 *
 * Usage:
 *   node scripts/import-pack.mjs --lang cs --sqlite wiktionary-morphology/wiktionary-morphology-packs/cs.sqlite --local
 *   node scripts/import-pack.mjs --lang en --sqlite path/to/en.sqlite --remote
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : null;
}

const lang = (arg('--lang') ?? '').trim().toLowerCase();
const sqlitePath = arg('--sqlite');
const remote = process.argv.includes('--remote');
const local = process.argv.includes('--local') || !remote;

if (!lang || !sqlitePath) {
  console.error('Need --lang CODE --sqlite path/to/lang.sqlite [--local|--remote]');
  process.exit(1);
}

const dbName = `dict-${lang}`;
const dir = mkdtempSync(join(tmpdir(), `d1-${lang}-`));
const dumpPath = join(dir, `${lang}.sql`);

console.log(`Dumping ${sqlitePath} → ${dumpPath}`);
const dump = spawnSync('sqlite3', [resolve(sqlitePath), '.dump'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 * 1024 });
if (dump.status !== 0) {
  console.error(dump.stderr || 'sqlite3 .dump failed');
  process.exit(dump.status ?? 1);
}

let sql = dump.stdout
  .replace(/^BEGIN TRANSACTION;$/gm, '')
  .replace(/^COMMIT;$/gm, '')
  .replace(/^PRAGMA .*;$/gm, '')
  .replace(/^CREATE TABLE _cf_KV[\s\S]*?;$/gm, '');

writeFileSync(dumpPath, sql);
console.log(`Importing into ${dbName} (${local ? 'local' : 'remote'})`);
const wrangler = spawnSync(
  'npx',
  ['wrangler', 'd1', 'execute', dbName, local ? '--local' : '--remote', '--file', dumpPath],
  { cwd: root, stdio: 'inherit' },
);
rmSync(dir, { recursive: true, force: true });
process.exit(wrangler.status ?? 1);
