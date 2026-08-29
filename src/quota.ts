export const RATE_LIMIT_MAX = 10;
export const RATE_LIMIT_PERIOD_SECONDS = 10;

export const RATE_LIMIT_HEADERS: Record<string, string> = {
  'X-RateLimit-Limit': String(RATE_LIMIT_MAX),
};

export function rateLimitedHeaders(): Record<string, string> {
  return {
    ...RATE_LIMIT_HEADERS,
    'Retry-After': String(RATE_LIMIT_PERIOD_SECONDS),
  };
}
