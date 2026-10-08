import { createHmac } from 'crypto';
import type { Db } from '../db/db';
import { derivedKey } from './keys';

/**
 * The per-username sign-in limit (06a §3.8, D-45). Failures are counted for every username
 * tried, whether or not the account exists, so the answer never reveals which exist:
 * - the try is taken BEFORE the password is checked, under a row lock, so a burst checks at
 *   most five;
 * - failures count within 15 minutes of the first; a success clears the count;
 * - the 5th failure starts a 15-minute pause, answered 429 too_many_attempts.
 * The row holds an HMAC of the login, never the login (R6-10).
 */
export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;
export const PAUSE_MS = 15 * 60 * 1000;

export function normaliseLogin(login: string): string {
  return login.trim().toLowerCase();
}

export function loginHmac(orgId: string, login: string): string {
  return createHmac('sha256', derivedKey('pharm/login-throttle/v1')).update(`${orgId}:${normaliseLogin(login)}`).digest('base64url');
}

export type Try = { kind: 'paused'; pausedUntil: Date } | { kind: 'counted'; pauses: boolean } | { kind: 'free' };

interface Row {
  failures: number;
  windowFrom: Date | null;
  pausedUntil: Date | null;
}

/**
 * Take a try for this username, inside the caller's tenant transaction. `counts` is false for
 * a try covered by the trusted-device allowance (R6-13): it is checked against a pause but not
 * counted.
 */
export async function takeTry(db: Db, orgId: string, hmac: string, at: Date, counts: boolean): Promise<Try> {
  await db.rows(`INSERT INTO sign_in_throttle (org_id, login_hmac, created_at, updated_at) VALUES ($1, $2, $3, $3)
                 ON CONFLICT (org_id, login_hmac) DO NOTHING`, [orgId, hmac, at]);
  const row = (await db.rows<Row>(
    `SELECT failures, window_from AS "windowFrom", paused_until AS "pausedUntil"
       FROM sign_in_throttle WHERE org_id = $1 AND login_hmac = $2 FOR UPDATE`, [orgId, hmac]))[0];
  if (row.pausedUntil && row.pausedUntil.getTime() > at.getTime()) return { kind: 'paused', pausedUntil: row.pausedUntil };
  if (!counts) return { kind: 'free' };
  // A lapsed pause or an expired window starts a fresh count.
  const fresh = row.pausedUntil !== null || !row.windowFrom || at.getTime() - row.windowFrom.getTime() >= WINDOW_MS;
  const failures = (fresh ? 0 : row.failures) + 1;
  const pauses = failures >= MAX_FAILURES;
  await db.rows(`UPDATE sign_in_throttle SET failures = $3, window_from = $4, paused_until = $5, updated_at = $6
                  WHERE org_id = $1 AND login_hmac = $2`,
    [orgId, hmac, pauses ? 0 : failures, fresh ? at : row.windowFrom, pauses ? new Date(at.getTime() + PAUSE_MS) : null, at]);
  return { kind: 'counted', pauses };
}

/** A successful sign-in clears the count (and any pause the try itself started). */
export async function clearTries(db: Db, orgId: string, hmac: string, at: Date): Promise<void> {
  await db.rows(`UPDATE sign_in_throttle SET failures = 0, window_from = NULL, paused_until = NULL, updated_at = $3
                  WHERE org_id = $1 AND login_hmac = $2`, [orgId, hmac, at]);
}

/**
 * R6-13: on a trusted device, 5 failures per username per device per 15 minutes do not count
 * toward the limit above; after that the device counts as untrusted for that username. Kept in
 * memory (one replica, 06a §3.8). The try is taken before the check, like the database count.
 */
const deviceTries = new Map<string, number[]>();

export function takeDeviceAllowance(deviceId: string, hmac: string, at: Date): boolean {
  const key = `${deviceId}:${hmac}`;
  const recent = (deviceTries.get(key) ?? []).filter((t) => at.getTime() - t < WINDOW_MS);
  recent.push(at.getTime());
  deviceTries.set(key, recent);
  return recent.length <= MAX_FAILURES;
}

export function clearDeviceAllowance(deviceId: string, hmac: string): void {
  deviceTries.delete(`${deviceId}:${hmac}`);
}
