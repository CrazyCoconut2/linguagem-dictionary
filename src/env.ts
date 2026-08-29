export const DICTIONARY_LANGUAGES = ['cs', 'de', 'en', 'es', 'fr', 'it', 'pl', 'pt'] as const;

export type DictionaryLanguage = (typeof DICTIONARY_LANGUAGES)[number];

export interface Env {
  /** Rest-server production `JWT_SECRET`. */
  JWT_SECRET: string;
  /** Rest-server staging `JWT_SECRET`. Optional; same Worker serves both apps. */
  JWT_SECRET_STAGING?: string;
  RATE_LIMIT: RateLimit;
  DB_CS: D1Database;
  DB_DE: D1Database;
  DB_EN: D1Database;
  DB_ES: D1Database;
  DB_FR: D1Database;
  DB_IT: D1Database;
  DB_PL: D1Database;
  DB_PT: D1Database;
}

const BINDINGS: Record<DictionaryLanguage, `DB_${Uppercase<DictionaryLanguage>}`> = {
  cs: 'DB_CS',
  de: 'DB_DE',
  en: 'DB_EN',
  es: 'DB_ES',
  fr: 'DB_FR',
  it: 'DB_IT',
  pl: 'DB_PL',
  pt: 'DB_PT',
};

export function jwtSecretsFromEnv(env: Pick<Env, 'JWT_SECRET' | 'JWT_SECRET_STAGING'>): string[] {
  return [
    ...new Set(
      [env.JWT_SECRET, env.JWT_SECRET_STAGING]
        .map((value) => String(value || '').trim())
        .filter(Boolean)
    ),
  ];
}

export function isDictionaryLanguage(value: string): value is DictionaryLanguage {
  return (DICTIONARY_LANGUAGES as readonly string[]).includes(value);
}

export function databaseFor(env: Env, language: string): D1Database | null {
  const lang = language.trim().toLowerCase();
  if (!isDictionaryLanguage(lang)) return null;
  return env[BINDINGS[lang]] ?? null;
}
