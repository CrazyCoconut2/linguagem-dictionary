const ACCESS_TYPE = 'access';

export async function verifyAccessJwt(
  request: Request,
  secret: string | undefined,
): Promise<string | null> {
  if (!secret) return null;
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)/i.exec(header.trim());
  if (!match) return null;
  return verifyHs256AccessToken(match[1], secret);
}

export async function verifyHs256AccessToken(
  token: string,
  secret: string,
): Promise<string | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  let header: { alg?: unknown };
  let payload: { sub?: unknown; typ?: unknown; exp?: unknown; nbf?: unknown };
  try {
    header = JSON.parse(bytesToUtf8(base64UrlToBytes(headerB64))) as { alg?: unknown };
    payload = JSON.parse(bytesToUtf8(base64UrlToBytes(payloadB64))) as {
      sub?: unknown;
      typ?: unknown;
      exp?: unknown;
      nbf?: unknown;
    };
  } catch {
    return null;
  }

  if (header.alg !== 'HS256') return null;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    base64UrlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!valid) return null;

  if (payload.typ !== ACCESS_TYPE) return null;
  const sub = typeof payload.sub === 'string' ? payload.sub.trim() : String(payload.sub ?? '').trim();
  if (!sub || sub === 'undefined' || sub === 'null') return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.nbf === 'number' && now < payload.nbf) return null;
  if (typeof payload.exp === 'number' && now >= payload.exp) return null;
  return sub;
}

function base64UrlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  const binary = atob(padded + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}
