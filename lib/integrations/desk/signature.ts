import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { AuthError } from '../../http/errors';

/**
 * The desk's signed requests (06a §12.5, D-57). HMAC-SHA256, keyed with DESK_SYNC_KEY, over
 *   DESK-SYNC-V1\n<METHOD>\n<path+query>\n<ts>\n<nonce>\n<sha256 hex of the raw body>
 * sent as `x-desk-ts` (unix seconds), `x-desk-nonce` (a UUID) and `x-desk-signature` (hex).
 * The timestamp must be within ±120 s of the server's clock; the nonce is single-use (stored,
 * and consumed in the request's own transaction).
 */
export const SIGNATURE_VERSION = 'DESK-SYNC-V1';
export const TS_WINDOW_S = 120;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX64 = /^[0-9a-f]{64}$/i;
const TS = /^\d{1,12}$/;

export const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

export function canonicalString(method: string, pathAndQuery: string, ts: string, nonce: string, body: string): string {
  return [SIGNATURE_VERSION, method.toUpperCase(), pathAndQuery, ts, nonce, sha256Hex(body)].join('\n');
}

/** The signature the desk sends (exported for the tests and as the reference for the desk side). */
export function signDeskRequest(key: string, method: string, pathAndQuery: string, ts: string, nonce: string, body: string): string {
  return createHmac('sha256', key).update(canonicalString(method, pathAndQuery, ts, nonce, body), 'utf8').digest('hex');
}

const badSignature = () => new AuthError(401, 'bad_signature', 'The request is not signed by the desk.');

/**
 * Check a request's signature, then its timestamp. Every malformed or missing header is
 * `bad_signature`, like a wrong signature; a signed request outside the window is
 * `stale_timestamp`. Returns the nonce to consume.
 */
export function verifyDeskSignature(key: string, req: Request, body: string, nowMs: number): { nonce: string; ts: number } {
  const ts = req.headers.get('x-desk-ts') ?? '';
  const nonce = req.headers.get('x-desk-nonce') ?? '';
  const sig = req.headers.get('x-desk-signature') ?? '';
  if (!TS.test(ts) || !UUID.test(nonce) || !HEX64.test(sig)) throw badSignature();
  const url = new URL(req.url);
  const expected = signDeskRequest(key, req.method, url.pathname + url.search, ts, nonce, body);
  if (!timingSafeEqual(Buffer.from(sig.toLowerCase(), 'hex'), Buffer.from(expected, 'hex'))) throw badSignature();
  if (Math.abs(Math.floor(nowMs / 1000) - Number(ts)) > TS_WINDOW_S) {
    throw new AuthError(401, 'stale_timestamp', 'The request is too old or from the future. Check the desk server\'s clock.');
  }
  return { nonce: nonce.toLowerCase(), ts: Number(ts) };
}
