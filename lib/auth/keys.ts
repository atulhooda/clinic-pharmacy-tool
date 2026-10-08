import { hkdfSync } from 'crypto';

/**
 * SESSION_SECRET and the keys derived from it (06a §3.4, §3.5, R6-10). Each use gets its own
 * HKDF-derived key, so a key for one purpose never verifies another. Rotating SESSION_SECRET
 * ends every session, untrusts every device cookie and resets every sign-in count.
 */
export function sessionSecret(): Uint8Array {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set to at least 32 characters');
  return new TextEncoder().encode(s);
}

export type KeyPurpose = 'pharm/device-cookie/v1' | 'pharm/login-throttle/v1';

export function derivedKey(purpose: KeyPurpose): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', sessionSecret(), new Uint8Array(0), purpose, 32));
}
