import { SignJWT, jwtVerify, errors } from 'jose';

/**
 * The session cookie (06a §3.4): an HS256 JWT {v: 1, org, sid} signed with SESSION_SECRET.
 * The token only says which session row to read; the row is re-read on every request.
 */
export const SESSION_COOKIE = 'pharm_session';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function key(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set to at least 32 characters');
  return new TextEncoder().encode(s);
}

export async function signSessionToken(org: string, sid: string, expiresAt: Date): Promise<string> {
  return new SignJWT({ v: 1, org, sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(key());
}

export type TokenResult = { ok: true; org: string; sid: string } | { ok: false; expired: boolean };

export async function readSessionToken(token: string, now: Date): Promise<TokenResult> {
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ['HS256'], currentDate: now });
    const { v, org, sid } = payload as { v?: unknown; org?: unknown; sid?: unknown };
    if (v !== 1 || typeof org !== 'string' || typeof sid !== 'string' || !UUID.test(org) || !UUID.test(sid)) {
      return { ok: false, expired: false };
    }
    return { ok: true, org, sid };
  } catch (err) {
    return { ok: false, expired: err instanceof errors.JWTExpired };
  }
}
