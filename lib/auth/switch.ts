import { withTenant } from '../db/tenant';
import { now } from '../clock';
import { HttpError, AuthError } from '../http/errors';
import { writeAudit } from '../audit';
import { hashPin, verifyPin } from './pins';
import { revokeSession } from './guard';
import { signSessionToken } from './token';
import type { DeviceClaim } from './device';

/**
 * The "Who's working?" lock screen on a trusted PC (06a §3.5, §3.8).
 *
 * The switch-PIN limit is per person across all devices: 5 wrong in 15 minutes blocks PIN
 * switching for that person until their next full sign-in. The try is taken under a row lock
 * BEFORE the PIN is checked, so a burst checks at most five (06b DW-13).
 */
const MAX_TRIES = 5;
const WINDOW_MS = 15 * 60 * 1000;

export const deviceRequired = () => new AuthError(401, 'device_required', 'This is not a trusted PC. Sign in with your password.');
const notFound = () => new HttpError(404, 'SESSION_NOT_FOUND', 'That person is not signed in on this PC.');

/** The device, if it exists and is still trusted; otherwise 401 device_required. */
async function trustedDeviceOrThrow(claim: DeviceClaim | null): Promise<DeviceClaim & { name: string; premisesId: string; slug: string; orgName: string }> {
  if (!claim) throw deviceRequired();
  const d = await withTenant(claim.org, async (db) => (await db.rows<{ name: string; premisesId: string; slug: string; orgName: string }>(
    `SELECT d.name, d.premises_id AS "premisesId", o.slug, o.display_name AS "orgName"
       FROM devices d JOIN organisations o ON o.id = d.org_id
      WHERE d.org_id = $1 AND d.id = $2 AND d.revoked_at IS NULL AND o.status = 'ACTIVE'`, [claim.org, claim.deviceId]))[0]);
  if (!d) throw deviceRequired();
  return { ...claim, ...d };
}

export interface LockScreen {
  org: { slug: string; displayName: string };
  device: { name: string };
  people: { sessionId: string; name: string; role: string }[];
}

/** A-10: the people with an open, unexpired session on this PC: name and role only. */
export async function lockScreen(claim: DeviceClaim | null): Promise<LockScreen> {
  const d = await trustedDeviceOrThrow(claim);
  const people = await withTenant(d.org, (db) => db.rows<{ sessionId: string; name: string; role: string }>(
    `SELECT s.id AS "sessionId", u.name, u.role_key AS role
       FROM sessions s JOIN staff_users u ON u.org_id = s.org_id AND u.id = s.staff_user_id
      WHERE s.org_id = $1 AND s.device_id = $2 AND s.revoked_at IS NULL AND s.expires_at > $3 AND u.active
      ORDER BY u.name`, [d.org, d.deviceId, now()]));
  return { org: { slug: d.slug, displayName: d.orgName }, device: { name: d.name }, people };
}

interface Target {
  sid: string;
  expiresAt: Date;
  staffUserId: string;
  name: string;
  roleKey: string;
  pinHash: string | null;
  failures: number;
  windowFrom: Date | null;
  blocked: boolean;
}

/** A-11: make another open session on this PC the active one, with that person's switch PIN. */
export async function switchPerson(claim: DeviceClaim | null, sessionId: string, pin: string): Promise<{ token: string; expiresAt: Date }> {
  const d = await trustedDeviceOrThrow(claim);
  const org = d.org;
  const at = now();

  // Transaction 1: find the session on this PC and take a try for its person.
  const t = await withTenant(org, async (db) => {
    const target = (await db.rows<Target>(
      `SELECT s.id AS sid, s.expires_at AS "expiresAt", u.id AS "staffUserId", u.name, u.role_key AS "roleKey",
              u.switch_pin_hash AS "pinHash", u.switch_pin_failures AS failures, u.switch_pin_window_from AS "windowFrom",
              u.switch_pin_blocked AS blocked
         FROM sessions s JOIN staff_users u ON u.org_id = s.org_id AND u.id = s.staff_user_id
        WHERE s.org_id = $1 AND s.id = $2 AND s.device_id = $3 AND s.revoked_at IS NULL AND u.active
        FOR UPDATE OF u`, [org, sessionId, d.deviceId]))[0];
    if (!target) return { kind: 'not_found' as const };
    if (target.expiresAt.getTime() <= at.getTime()) {
      await revokeSession(db, org, target.sid, 'expired');
      return { kind: 'expired' as const };
    }
    if (!target.pinHash) return { kind: 'no_pin' as const };
    if (target.blocked) return { kind: 'blocked' as const };
    const fresh = !target.windowFrom || at.getTime() - target.windowFrom.getTime() >= WINDOW_MS;
    const failures = (fresh ? 0 : target.failures) + 1;
    const blocks = failures >= MAX_TRIES;
    await db.rows(`UPDATE staff_users SET switch_pin_failures = $3, switch_pin_window_from = $4, switch_pin_blocked = $5
                    WHERE org_id = $1 AND id = $2`, [org, target.staffUserId, failures, fresh ? at : target.windowFrom, blocks]);
    return { kind: 'try' as const, target, failures, blocks };
  });
  if (t.kind === 'not_found') throw notFound();
  if (t.kind === 'expired') throw new AuthError(401, 'session_expired', 'That session has ended for the day. Sign in again.');
  if (t.kind === 'no_pin') throw new AuthError(403, 'switch_pin_required', 'Set a switch PIN after signing in with your password.');
  if (t.kind === 'blocked') throw blockedError();

  const target = t.target;
  const check = await verifyPin(pin, target.pinHash);
  if (!check.ok) {
    if (t.blocks) {
      await withTenant(org, (db) => writeAudit(db, { orgId: org, action: 'auth.switch_pin_blocked', actorLabel: target.name,
        actorRole: target.roleKey, staffUserId: target.staffUserId, deviceId: d.deviceId, entityId: target.staffUserId }));
      throw blockedError();
    }
    throw new AuthError(401, 'wrong_secret', 'That PIN is not right.', { remaining: MAX_TRIES - t.failures });
  }
  const rehash = check.stale ? await hashPin(pin) : null;

  // Transaction 2: the switch. Updating the device's state row waits for any in-flight write
  // that holds it FOR SHARE (§3.5 point 4).
  await withTenant(org, async (db) => {
    await db.rows(`UPDATE staff_users SET switch_pin_failures = 0, switch_pin_window_from = NULL, switch_pin_blocked = false
                           ${rehash ? ', switch_pin_hash = $3' : ''}
                    WHERE org_id = $1 AND id = $2`, rehash ? [org, target.staffUserId, rehash] : [org, target.staffUserId]);
    await db.rows(`INSERT INTO device_state (org_id, device_id, updated_at) VALUES ($1, $2, $3)
                   ON CONFLICT (org_id, device_id) DO NOTHING`, [org, d.deviceId, at]);
    const from = (await db.rows<{ active: string | null }>(
      'SELECT active_session_id AS active FROM device_state WHERE org_id = $1 AND device_id = $2 FOR UPDATE', [org, d.deviceId]))[0].active;
    await db.rows('UPDATE device_state SET active_session_id = $3, updated_at = $4 WHERE org_id = $1 AND device_id = $2',
      [org, d.deviceId, target.sid, at]);
    // Picking your name and typing your PIN is input: the idle clock restarts.
    await db.rows('UPDATE sessions SET last_input_at = $3 WHERE org_id = $1 AND id = $2', [org, target.sid, at]);
    await db.rows('UPDATE devices SET last_seen_at = $3 WHERE org_id = $1 AND id = $2', [org, d.deviceId, at]);
    await writeAudit(db, { orgId: org, action: 'auth.switched', actorLabel: target.name, actorRole: target.roleKey,
      staffUserId: target.staffUserId, sessionId: target.sid, deviceId: d.deviceId, entityId: target.staffUserId,
      detail: { device_id: d.deviceId, from_session_id: from, to_session_id: target.sid } });
  });
  return { token: await signSessionToken(org, target.sid, target.expiresAt), expiresAt: target.expiresAt };
}

function blockedError(): AuthError {
  return new AuthError(403, 'switch_pin_blocked', 'PIN switching is blocked for this person. Sign in with your password.');
}
