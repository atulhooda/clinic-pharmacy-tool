import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'crypto';
import { parsePeppers } from './pepper-config.cjs';

/**
 * PIN hashing with a pepper held outside the database (06a §3.12, D-34):
 * scrypt(HMAC-SHA256(pepper_v, pin), salt), stored as scrypt$15$8$1$p<v>$<salt>$<key>. The DB
 * CHECKs that shape. The pepper is never logged, stored or put in an error message.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const SHAPE = /^scrypt\$15\$8\$1\$p([0-9]{1,3})\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{32,})$/;

export class PepperConfigError extends Error {}

let cache: { raw: string | undefined; peppers: Map<number, Buffer>; current: number } | undefined;

/** The parsed PIN_PEPPERS; re-read when the variable changes (a deploy, or a test's restart). */
export function peppers(): { peppers: Map<number, Buffer>; current: number } {
  const raw = process.env.PIN_PEPPERS;
  if (cache && cache.raw === raw) return cache;
  const p = parsePeppers(raw);
  if (!p.ok) throw new PepperConfigError(p.check);
  cache = { raw, peppers: p.peppers, current: p.current };
  return cache;
}

/** Tests count real PIN checks (06b DW-13: a burst checks at most five). */
export const pinCounters = { checks: 0 };

function scrypt(input: Buffer, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => scryptCb(input, salt, 32, PARAMS, (err, key) => (err ? reject(err) : resolve(key))));
}

function peppered(pin: string, pepper: Buffer): Buffer {
  return createHmac('sha256', pepper).update(pin, 'utf8').digest();
}

/** 06a §3.8: exactly 6 digits; no repeats (000000) and no straight runs (123456, 654321). */
export function pinFormatOk(pin: string): boolean {
  if (!/^[0-9]{6}$/.test(pin)) return false;
  const d = [...pin].map(Number);
  const steps = d.slice(1).map((x, i) => x - d[i]);
  return !(steps.every((s) => s === 0) || steps.every((s) => s === 1) || steps.every((s) => s === -1));
}

export async function hashPin(pin: string): Promise<string> {
  const { peppers: all, current } = peppers();
  const salt = randomBytes(16);
  const key = await scrypt(peppered(pin, all.get(current)!), salt);
  return `scrypt$15$8$1$p${current}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/**
 * Checks a PIN. `stale` means the hash was made with an older pepper and should be re-hashed
 * with the current one in the same transaction (lazy re-hash, §3.12 step 2).
 */
export async function verifyPin(pin: string, stored: string | null): Promise<{ ok: boolean; stale: boolean }> {
  pinCounters.checks++;
  const m = stored ? SHAPE.exec(stored) : null;
  if (!m) return { ok: false, stale: false };
  const { peppers: all, current } = peppers();
  const version = Number(m[1]);
  const pepper = all.get(version);
  // The startup check guarantees every stored version is configured; fail closed if not.
  if (!pepper) throw new PepperConfigError(`stored PIN hash uses pepper version ${version}, which PIN_PEPPERS lacks`);
  const expected = Buffer.from(m[3], 'base64url');
  const actual = await scrypt(peppered(pin, pepper), Buffer.from(m[2], 'base64url'));
  const ok = actual.length === expected.length && timingSafeEqual(actual, expected);
  return { ok, stale: ok && version !== current };
}
