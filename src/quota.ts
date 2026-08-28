export const DAILY_QUOTA = 10_000;

export type QuotaSnapshot = {
  allowed: boolean;
  used: number;
  remaining: number;
  limit: number;
  retryAfterSeconds: number;
  resetEpoch: number;
};

export function utcDay(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function nextUtcMidnightEpoch(nowMs = Date.now()): number {
  const date = new Date(nowMs);
  return Math.floor(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) / 1000,
  );
}

export async function consumeDailyQuota(
  db: D1Database,
  userId: string,
  nowMs = Date.now(),
): Promise<QuotaSnapshot> {
  const day = utcDay(nowMs);
  const resetEpoch = nextUtcMidnightEpoch(nowMs);
  const retryAfterSeconds = Math.max(1, resetEpoch - Math.floor(nowMs / 1000));
  const row = await db
    .prepare(
      `INSERT INTO daily_quota (user_id, day, n) VALUES (?, ?, 1)
       ON CONFLICT (user_id, day) DO UPDATE SET n = n + 1
       RETURNING n`,
    )
    .bind(userId, day)
    .first<{ n: number }>();
  const used = Number(row?.n ?? 0);
  const allowed = used <= DAILY_QUOTA;
  return {
    allowed,
    used,
    remaining: Math.max(0, DAILY_QUOTA - used),
    limit: DAILY_QUOTA,
    retryAfterSeconds,
    resetEpoch,
  };
}

export function quotaHeaders(quota: QuotaSnapshot): Record<string, string> {
  return {
    'X-RateLimit-Limit': String(quota.limit),
    'X-RateLimit-Remaining': String(quota.remaining),
    'X-RateLimit-Reset': String(quota.resetEpoch),
  };
}
