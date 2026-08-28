/** D1 allows 100 bound parameters per statement. Leave room for extra binds. */
export const BIND_CHUNK = 80;

export type SqlValue = string | number | null;

export async function selectRows<T extends Record<string, unknown>>(
  db: D1Database,
  sql: string,
  bind: SqlValue[] = [],
): Promise<T[]> {
  const stmt = bind.length > 0 ? db.prepare(sql).bind(...bind) : db.prepare(sql);
  const result = await stmt.all<T>();
  return (result.results ?? []) as T[];
}

export async function selectScalar(db: D1Database, sql: string, bind: SqlValue[] = []): Promise<number> {
  const rows = await selectRows<{ v?: number | string | null }>(db, sql, bind);
  const v = rows[0]?.v;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function posPlaceholders(n: number): string {
  return Array.from({ length: n }, () => '?').join(',');
}

export async function getPackMeta(db: D1Database, key: string): Promise<string | null> {
  const rows = await selectRows<{ value?: string }>(db, 'SELECT value FROM meta WHERE key = ?', [key]);
  const value = rows[0]?.value;
  return typeof value === 'string' ? value : null;
}
