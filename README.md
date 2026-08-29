# linguagem-dictionary-api

Cloudflare Worker + one D1 database per language. The learner app looks up
lemmas and surface forms on demand — it does not download SQLite packs.

## Setup

1. Workers Paid (French/German packs are over the Free 500 MB/db limit).
2. Create databases and paste the IDs into `wrangler.toml`:

```sh
npx wrangler d1 create dict-cs
# … dict-de dict-en dict-es dict-fr dict-it dict-pl dict-pt
```

3. Set JWT secrets (same values as rest-server per env). One Worker serves both production and staging apps:

```sh
npx wrangler secret put JWT_SECRET
npx wrangler secret put JWT_SECRET_STAGING
```

Local wrangler: copy `.dev.vars.example` to `.dev.vars`. Wrangler 4.36+ (rate limiting binding).

4. Import packs from `wiktionary-morphology/` (dumps `.sqlite` into D1):

```sh
npm run deploy:d1 -- --lang cs --remote
# or: npm run deploy:d1:all
```

5. `npm run dev` (http://localhost:8787) or `npm run deploy`.

Production Worker: `https://dictionary-api.linguagem.xyz`  
Fallback: `https://linguagem-dictionary-api.mohammed-tigrini.workers.dev`

## GitHub Actions

Pushes to `main` (and manual **Run workflow**) typecheck then deploy the Worker.
Pull requests only typecheck.

Add these repository secrets (same account as `linguagem-app`):

- `CLOUDFLARE_API_TOKEN` — Account permission **Workers Scripts: Edit** (and **D1: Edit** if you also import packs from CI)
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID for this Worker

JWT secrets are Wrangler secrets on the Worker, not GitHub secrets:

```sh
npx wrangler secret put JWT_SECRET            # rest-server production JWT_SECRET
npx wrangler secret put JWT_SECRET_STAGING    # rest-server staging JWT_SECRET
```

Staging and production apps both call this Worker; a token verifies if it matches either secret.

## HTTP

Unauthenticated:

- `GET /` or `GET /health` — `{ ok: true }` if the Worker is configured

All pack routes are `/v1/:lang/…` (`cs|de|en|es|fr|it|pl|pt`) and require
`Authorization: Bearer <rest-server access JWT>` (`typ=access`). Each Linguagem
user may make **10 pack calls per 10 seconds** (about 1/s, with a short burst).
Further calls return **429** with `Retry-After: 10` and `X-RateLimit-Limit: 10`.
Missing or refresh tokens return **401**.

- `GET /meta`
- `GET /lookup?q=&limit=` — exact lemma or variation
- `GET /pos`
- `GET /lemmas/:lemma`
- `GET /lemmas/:lemma/forms`
- `POST /lemmas/batch` `{ lemmas, stats? }`
