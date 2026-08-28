#!/usr/bin/env node
/**
 * Local GUI to verify morphology SQLite pattern search.
 *
 * Usage:
 *   npm run gui
 *   node gui/server.js --port 8787
 */

import { createServer } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getLemmaDetail,
  getMeta,
  getVariationDetail,
  listPos,
  openPack,
  queryDictionaryPage,
  searchMorphology,
} from "../search.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PUBLIC_DIR = resolve(__dirname, "public");
const DEFAULT_PACKS = resolve(ROOT, "wiktionary-morphology-packs");

/** @type {Map<string, { db: import('better-sqlite3').Database, mtimeMs: number }>} */
const dbCache = new Map();

function parseArgs(argv) {
  const opts = {
    port: 8787,
    packs: DEFAULT_PACKS,
    host: "127.0.0.1",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else if (arg === "--port") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 1) throw new Error("--port expects a port");
      opts.port = Math.floor(n);
    } else if (arg === "--host") {
      opts.host = String(argv[++i] ?? "");
      if (!opts.host) throw new Error("--host expects a value");
    } else if (arg === "--packs") {
      opts.packs = resolve(String(argv[++i] ?? ""));
      if (!opts.packs) throw new Error("--packs expects a path");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  return opts;
}

function listLanguages(packsDir) {
  if (!existsSync(packsDir)) return [];
  return readdirSync(packsDir)
    .filter((name) => name.endsWith(".sqlite"))
    .map((name) => name.slice(0, -".sqlite".length))
    .sort((a, b) => a.localeCompare(b));
}

function dbPathFor(packsDir, lang) {
  return resolve(packsDir, `${lang}.sqlite`);
}

function getDb(packsDir, lang) {
  const code = lang.trim().toLowerCase();
  if (!code || code.includes("/") || code.includes("..")) {
    throw Object.assign(new Error("Invalid language"), { status: 400 });
  }
  const path = dbPathFor(packsDir, code);
  if (!existsSync(path)) {
    throw Object.assign(new Error(`Pack not found: ${code}.sqlite`), {
      status: 404,
    });
  }
  const mtimeMs = statSync(path).mtimeMs;
  const cached = dbCache.get(code);
  if (cached && cached.mtimeMs === mtimeMs) {
    return { db: cached.db, lang: code, path };
  }
  if (cached) {
    try {
      cached.db.close();
    } catch {
      /* ignore */
    }
  }
  const db = openPack(path);
  dbCache.set(code, { db, mtimeMs });
  return { db, lang: code, path };
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
    "Cache-Control": "no-store",
  });
  res.end(data);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function contentType(filePath) {
  switch (extname(filePath)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  rel = decodeURIComponent(rel.split("?")[0]);
  if (rel.includes("..")) {
    sendText(res, 400, "Bad path");
    return;
  }
  const filePath = join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }
  const body = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": contentType(filePath),
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function handleApi(req, res, packsDir, url) {
  const path = url.pathname;

  if (req.method === "GET" && path === "/api/languages") {
    const languages = listLanguages(packsDir).map((lang) => {
      const sqlitePath = dbPathFor(packsDir, lang);
      const st = statSync(sqlitePath);
      let version = null;
      let schemaVersion = null;
      let builtAt = null;
      try {
        const { db } = getDb(packsDir, lang);
        version = getMeta(db, "version");
        schemaVersion = getMeta(db, "schema_version");
        builtAt = getMeta(db, "built_at");
      } catch {
        /* ignore */
      }
      return {
        lang,
        size: st.size,
        version,
        schemaVersion,
        builtAt,
      };
    });
    sendJson(res, 200, { packsDir, languages });
    return;
  }

  if (req.method === "GET" && path === "/api/pos") {
    const lang = url.searchParams.get("lang") ?? "";
    const { db } = getDb(packsDir, lang);
    sendJson(res, 200, { lang, pos: listPos(db) });
    return;
  }

  if (req.method === "GET" && path === "/api/search") {
    const lang = url.searchParams.get("lang") ?? "";
    const pattern = url.searchParams.get("pattern") ?? "";
    const scope = url.searchParams.get("scope") ?? "all";
    const pos = (url.searchParams.get("pos") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const limit = Number(url.searchParams.get("limit") ?? 50);
    const offset = Number(url.searchParams.get("offset") ?? 0);
    const { db } = getDb(packsDir, lang);
    const result = searchMorphology(db, {
      pattern,
      scope,
      pos,
      limit: Number.isFinite(limit) ? limit : 50,
      offset: Number.isFinite(offset) ? offset : 0,
    });
    sendJson(res, 200, { lang, ...result });
    return;
  }

  if (req.method === "GET" && path === "/api/dictionary") {
    const lang = url.searchParams.get("lang") ?? "";
    const query = url.searchParams.get("q") ?? "";
    const pos = (url.searchParams.get("pos") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const sort = url.searchParams.get("sort") ?? "lemma-asc";
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("pageSize") ?? 48);
    const { db } = getDb(packsDir, lang);
    const result = queryDictionaryPage(db, {
      query,
      pos,
      sort,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 48,
    });
    sendJson(res, 200, { lang, ...result });
    return;
  }

  if (req.method === "GET" && path === "/api/detail") {
    const lang = url.searchParams.get("lang") ?? "";
    const token = url.searchParams.get("token") ?? "";
    const kind = url.searchParams.get("kind") ?? "";
    const { db } = getDb(packsDir, lang);
    if (!token) {
      sendJson(res, 400, { error: "token required" });
      return;
    }
    if (kind === "lemma") {
      const detail = getLemmaDetail(db, token);
      if (!detail) {
        sendJson(res, 404, { error: "lemma not found" });
        return;
      }
      sendJson(res, 200, { lang, kind, detail });
      return;
    }
    if (kind === "variation") {
      const detail = getVariationDetail(db, token);
      if (!detail) {
        sendJson(res, 404, { error: "variation not found" });
        return;
      }
      sendJson(res, 200, { lang, kind, detail });
      return;
    }
    const lemma = getLemmaDetail(db, token);
    if (lemma) {
      sendJson(res, 200, { lang, kind: "lemma", detail: lemma });
      return;
    }
    const variation = getVariationDetail(db, token);
    if (variation) {
      sendJson(res, 200, { lang, kind: "variation", detail: variation });
      return;
    }
    sendJson(res, 404, { error: "not found" });
    return;
  }

  if (req.method === "POST" && path === "/api/search") {
    // body handled by caller with async
    return false;
  }

  sendJson(res, 404, { error: "unknown api route" });
  return true;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(`Usage: node ${basename(fileURLToPath(import.meta.url))} [options]

Options:
  --port N       Port (default: 8787)
  --host HOST    Bind address (default: 127.0.0.1)
  --packs PATH   Packs directory (default: wiktionary-morphology-packs/)
  --help         Show this help`);
    return;
  }

  if (!existsSync(PUBLIC_DIR)) {
    throw new Error(`Missing GUI public dir: ${PUBLIC_DIR}`);
  }

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host ?? `${opts.host}:${opts.port}`;
      const url = new URL(req.url ?? "/", `http://${host}`);

      if (url.pathname.startsWith("/api/")) {
        if (req.method === "POST" && url.pathname === "/api/search") {
          const body = await readBody(req);
          const lang = String(body.lang ?? "");
          const { db } = getDb(opts.packs, lang);
          const result = searchMorphology(db, {
            pattern: String(body.pattern ?? ""),
            scope: body.scope ?? "all",
            pos: Array.isArray(body.pos) ? body.pos : [],
            limit: body.limit,
            offset: body.offset,
          });
          sendJson(res, 200, { lang, ...result });
          return;
        }
        handleApi(req, res, opts.packs, url);
        return;
      }

      serveStatic(req, res, url.pathname);
    } catch (err) {
      const status = err?.status ?? 500;
      if (status >= 500) console.error(err);
      sendJson(res, status, { error: err?.message ?? String(err) });
    }
  });

  server.listen(opts.port, opts.host, () => {
    const langs = listLanguages(opts.packs);
    console.error(`Morphology search GUI`);
    console.error(`  http://${opts.host}:${opts.port}/`);
    console.error(`  packs: ${opts.packs}`);
    console.error(
      langs.length
        ? `  languages: ${langs.join(", ")}`
        : `  languages: (none — run npm run build:pt first)`,
    );
  });

  const shutdown = () => {
    for (const cached of dbCache.values()) {
      try {
        cached.db.close();
      } catch {
        /* ignore */
      }
    }
    dbCache.clear();
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
