import { verifyAccessJwt } from './auth';
import { json, noContent, withHeaders } from './cors';
import { databaseFor, isDictionaryLanguage, type Env } from './env';
import {
  getDictionaryEntry,
  getLemmaDetail,
  getPackMetaVersion,
  listDistinctPos,
  listEntriesForLemmas,
  listFormsForLemma,
  listSenseStatsForLemmas,
  lookupDictionaryTerm,
} from './lemma';
import { consumeDailyQuota, quotaHeaders } from './quota';

function isHealthPath(parts: string[]): boolean {
  return parts.length === 0 || (parts.length === 1 && parts[0] === 'health');
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') return noContent(request);

    const url = new URL(request.url);
    const parts = url.pathname.replace(/\/+$/, '').split('/').filter(Boolean);

    if (request.method === 'GET' && isHealthPath(parts)) {
      return health(request, env);
    }

    if (parts[0] !== 'v1' || !parts[1]) {
      return json(request, { error: 'Not found' }, 404);
    }

    if (!env.JWT_SECRET) {
      return json(request, { error: 'Server misconfigured' }, 500);
    }
    const userId = await verifyAccessJwt(request, env.JWT_SECRET);
    if (!userId) {
      return json(request, { error: 'Unauthorized' }, 401);
    }

    if (!env.DB_QUOTA) {
      return json(request, { error: 'Quota store unavailable' }, 503);
    }
    const quota = await consumeDailyQuota(env.DB_QUOTA, userId);
    const limits = quotaHeaders(quota);
    if (!quota.allowed) {
      return json(request, { error: 'Daily dictionary quota exceeded' }, 429, {
        ...limits,
        'Retry-After': String(quota.retryAfterSeconds),
      });
    }

    const lang = parts[1].toLowerCase();
    if (!isDictionaryLanguage(lang)) {
      return json(request, { error: `Unknown language "${lang}"` }, 404, limits);
    }
    const db = databaseFor(env, lang);
    if (!db) {
      return json(request, { error: `No dictionary for "${lang}"` }, 503, limits);
    }

    try {
      const response = await route(request, url, parts.slice(2), db, lang);
      return withHeaders(response, limits);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'Cancelled' && err instanceof Error && err.name === 'AbortError') {
        return json(request, { error: 'Cancelled' }, 499, limits);
      }
      console.error(message);
      return json(request, { error: message }, 500, limits);
    }
  },
} satisfies ExportedHandler<Env>;

async function health(request: Request, env: Env): Promise<Response> {
  if (!env.JWT_SECRET) {
    return json(request, { ok: false, error: 'Server misconfigured' }, 503);
  }
  if (!env.DB_QUOTA) {
    return json(request, { ok: false, error: 'Quota store unavailable' }, 503);
  }
  try {
    await env.DB_QUOTA.prepare('SELECT 1 AS ok').first();
  } catch {
    return json(request, { ok: false, error: 'Quota store unavailable' }, 503);
  }
  return json(request, { ok: true });
}

async function route(
  request: Request,
  url: URL,
  rest: string[],
  db: D1Database,
  lang: string,
): Promise<Response> {
  const method = request.method;
  const head = rest[0] ?? '';

  if (method === 'GET' && head === 'meta' && rest.length === 1) {
    const meta = await getPackMetaVersion(db);
    return json(request, { language: lang, ...meta });
  }

  if (method === 'GET' && head === 'lookup' && rest.length === 1) {
    const q = url.searchParams.get('q') ?? '';
    const limit = Number(url.searchParams.get('limit') ?? '');
    const matches = await lookupDictionaryTerm(db, q, {
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });
    return json(request, { matches });
  }

  if (method === 'GET' && head === 'pos' && rest.length === 1) {
    const maxValues = Number(url.searchParams.get('max') ?? '200');
    const pos = await listDistinctPos(db, maxValues);
    return json(request, { pos });
  }

  if (method === 'GET' && head === 'lemmas' && rest.length === 2) {
    const lemma = decodeURIComponent(rest[1] ?? '');
    const detail = await getLemmaDetail(db, lemma);
    if (!detail) return json(request, { error: 'Not found' }, 404);
    return json(request, detail);
  }

  if (method === 'GET' && head === 'lemmas' && rest.length === 3 && rest[2] === 'forms') {
    const lemma = decodeURIComponent(rest[1] ?? '');
    const limit = Number(url.searchParams.get('limit') ?? '');
    const forms = await listFormsForLemma(db, lemma, {
      limit: Number.isFinite(limit) && limit > 0 ? limit : undefined,
    });
    return json(request, { forms });
  }

  if (method === 'GET' && head === 'entry' && rest.length === 2) {
    const lemma = decodeURIComponent(rest[1] ?? '');
    const entry = await getDictionaryEntry(db, lemma);
    if (!entry) return json(request, { error: 'Not found' }, 404);
    return json(request, entry);
  }

  if (method === 'POST' && head === 'lemmas' && rest[1] === 'batch' && rest.length === 2) {
    const body = (await request.json()) as { lemmas?: string[]; stats?: boolean };
    const lemmas = Array.isArray(body.lemmas) ? body.lemmas : [];
    if (body.stats) {
      return json(request, await listSenseStatsForLemmas(db, lemmas));
    }
    return json(request, await listEntriesForLemmas(db, lemmas));
  }

  return json(request, { error: 'Not found' }, 404);
}
