export const DICTIONARY_LANGUAGES = ['cs', 'de', 'en', 'es', 'fr', 'it', 'pl', 'pt'] as const;

export type DictionaryLanguage = (typeof DICTIONARY_LANGUAGES)[number];

export interface Env {
  JWT_SECRET: string;
  DB_QUOTA: D1Database;
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

export function isDictionaryLanguage(value: string): value is DictionaryLanguage {
  return (DICTIONARY_LANGUAGES as readonly string[]).includes(value);
}

export function databaseFor(env: Env, language: string): D1Database | null {
  const lang = language.trim().toLowerCase();
  if (!isDictionaryLanguage(lang)) return null;
  return env[BINDINGS[lang]] ?? null;
}
