# linguagem-dictionary-api

Cloudflare Worker + one D1 database per language. The learner app looks up
lemmas and surface forms on demand — it does not download SQLite packs.

## Setup

1. Workers Paid (French/German packs are over the Free 500 MB/db limit).
2. Create databases and paste the IDs into `wrangler.toml`:

```sh
npx wrangler d1 create dict-quota
npx wrangler d1 create dict-cs
# … dict-de dict-en dict-es dict-fr dict-it dict-pl dict-pt
```

3. Apply the quota schema and set the JWT secret (same value as rest-server `JWT_SECRET`):

```sh
npx wrangler d1 execute dict-quota --file=schema/quota.sql
npx wrangler d1 execute dict-quota --remote --file=schema/quota.sql
npx wrangler secret put JWT_SECRET
```

Local wrangler: copy `.dev.vars.example` to `.dev.vars`.

4. Import packs from `wiktionary-morphology/` (dumps `.sqlite` into D1):

```sh
npm run deploy:d1 -- --lang cs --remote
# or: npm run deploy:d1:all
```

5. `npm run dev` (http://localhost:8787) or `npm run deploy`.

## HTTP

All pack routes are `/v1/:lang/…` (`cs|de|en|es|fr|it|pl|pt`) and require
`Authorization: Bearer <rest-server access JWT>` (`typ=access`). Each Linguagem
user may make **10,000** pack calls per UTC day; further calls return **429** with
`Retry-After` and `X-RateLimit-*` headers. Missing or refresh tokens return **401**.

- `GET /meta`
- `GET /lookup?q=&limit=` — exact lemma or variation
- `GET /pos`
- `GET /lemmas/:lemma`
- `GET /lemmas/:lemma/forms`
- `POST /lemmas/batch` `{ lemmas, stats? }`
