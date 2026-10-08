import { randomBytes, randomInt, scrypt as scryptCb, timingSafeEqual } from 'crypto';

/**
 * Passwords (06a §3.2, §3.8): scrypt with N = 2^15, r = 8, p = 1, a 32-byte key and a 16-byte
 * salt (the Ritu Desk parameters), stored as scrypt$15$8$1$<salt>$<key> (base64url). The DB
 * CHECKs that shape. PINs use the peppered variant in PR 3 (§3.12).
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SHAPE = /^scrypt\$15\$8\$1\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{32,})$/;

function scrypt(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(secret.normalize('NFC'), salt, 32, PARAMS, (err, key) => (err ? reject(err) : resolve(key))));
}

/** Tests count real verifications against stored hashes, and dummy ones (06b DN-02, DN-04). */
export const verifyCounters = { real: 0, dummy: 0 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt);
  return `scrypt$15$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  verifyCounters.real++;
  const m = SHAPE.exec(stored);
  if (!m) return false;
  const expected = Buffer.from(m[2], 'base64url');
  const actual = await scrypt(password, Buffer.from(m[1], 'base64url'));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const DUMMY_SALT = Buffer.alloc(16, 7);
/** Same cost as a real check, for unknown logins and paused accounts (no timing oracle). */
export async function dummyVerify(): Promise<void> {
  verifyCounters.dummy++;
  await scrypt('not-a-real-password', DUMMY_SALT);
}

const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop',
  'iloveyou', 'admin123', 'welcome1', 'welcome123', 'letmein1', 'abc12345', 'abcd1234', '11111111', '00000000',
  'pharmacy', 'pharmacy1', 'pharmacy123', 'clinic123', 'doctor123', 'india123', 'passw0rd', 'p@ssw0rd',
]);

/** §3.8. Returns a rule code, or null when the password is acceptable. */
export function passwordPolicy(password: string, who: { login: string; name: string }): string | null {
  const len = [...password].length;
  if (len < 8 || len > 128) return 'length';
  const lower = password.toLowerCase();
  if (lower === who.login.toLowerCase() || lower === who.name.toLowerCase()) return 'same_as_login_or_name';
  if (COMMON.has(lower)) return 'too_common';
  return null;
}

const OTP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
/** A one-time password: 12 characters, no 0/O/1/l/I. Shown once, never stored in clear. */
export function oneTimePassword(): string {
  let out = '';
  for (let i = 0; i < 12; i++) out += OTP_ALPHABET[randomInt(OTP_ALPHABET.length)];
  return out;
}
