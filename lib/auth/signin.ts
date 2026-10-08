import { withTenant } from '../db/tenant';
import { resolveOrgBySlug } from '../db/orgs';
import { now } from '../clock';
import { HttpError, AuthError } from '../http/errors';
import { writeAudit, auditBestEffort } from '../audit';
import { dummyVerify, verifyPassword } from './password';
import { ipRetryAfter, recordIpFailure } from './limits';
import { sessionExpiry } from './expiry';
import { signSessionToken } from './token';
import type { DeviceClaim } from './device';
import { loginHmac, normaliseLogin, takeTry, clearTries, takeDeviceAllowance, clearDeviceAllowance, PAUSE_MS } from './throttle';

/**
 * Password sign-in (06a §3.3, §3.8; Milestone 1 has no OTP, D-39).
 *
 * - Failures are counted per submitted username, whether or not the account exists (D-45).
 *   The 5th failure, and every try in the next 15 minutes, answers 429 too_many_attempts,
 *   the same for a real and an unknown username. A pause never ends a live session.
 * - Unknown logins run a dummy scrypt check, so timing does not reveal which logins exist.
 *   The typed login is never logged, audited or stored (only its HMAC, R6-10).
 * - On a trusted device (§3.5) the device cookie's organisation wins; the new session is bound
 *   to the device and becomes its active one; the same person's earlier session there is
 *   replaced; nobody else's session ends.
 */
const invalid = () => new AuthError(401, 'invalid_credentials',
  'Wrong login or password. After 5 wrong tries, sign-in pauses for 15 minutes.');

function tooMany(pausedUntil: Date, at: Date): HttpError {
  const seconds = Math.max(1, Math.ceil((pausedUntil.getTime() - at.getTime()) / 1000));
  const minutes = Math.ceil(seconds / 60);
  return new HttpError(429, 'too_many_attempts', `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    undefined, { 'retry-after': String(seconds) });
}

export interface SignInResult {
  token: string;
  expiresAt: Date;
  next: string;
  /** The trusted device the session is bound to, or null. */
  deviceId: string | null;
  /** A device cookie that named a revoked or unknown device: the route clears it. */
  staleDeviceCookie: boolean;
}

interface UserRow {
  id: string;
  name: string;
  roleKey: string;
  active: boolean;
  passwordHash: string | null;
  mustChange: boolean;
  hasSwitchPin: boolean;
}

/** The device cookie's organisation and device, if the device is still trusted. */
async function trustedDevice(claim: DeviceClaim | null): Promise<{ orgId: string; deviceId: string } | null> {
  if (!claim) return null;
  const row = await withTenant(claim.org, async (db) => (await db.rows<{ ok: boolean }>(
    `SELECT d.revoked_at IS NULL AND o.status = 'ACTIVE' AS ok
       FROM devices d JOIN organisations o ON o.id = d.org_id
      WHERE d.org_id = $1 AND d.id = $2`, [claim.org, claim.deviceId]))[0]);
  return row?.ok ? { orgId: claim.org, deviceId: claim.deviceId } : null;
}

export async function signInWithPassword(
  input: { orgSlug: string; login: string; password: string },
  ip: string,
  deviceClaim: DeviceClaim | null = null,
): Promise<SignInResult> {
  const at = now();
  const retry = ipRetryAfter(ip, at);
  if (retry > 0) {
    throw new HttpError(429, 'too_many_attempts', 'Too many attempts from this network. Try again in a few minutes.',
      undefined, { 'retry-after': String(retry) });
  }
  const audit = (orgId: string, reason: string, staffUserId: string | null, extra: Record<string, unknown> = {}) =>
    auditBestEffort({ orgId, action: 'auth.sign_in_failed', actorLabel: 'unknown', actorRole: 'anonymous',
      staffUserId, entityId: staffUserId, deviceId: device?.deviceId ?? null, detail: { method: 'password', reason, ...extra } });

  const device = await trustedDevice(deviceClaim);
  const staleDeviceCookie = deviceClaim !== null && device === null;
  let orgId: string;
  if (device) {
    orgId = device.orgId;
  } else {
    const org = await resolveOrgBySlug(input.orgSlug);
    if (!org) {
      await dummyVerify();
      recordIpFailure(ip, at);
      throw invalid();
    }
    orgId = org.id;
  }
  const login = normaliseLogin(input.login);
  const hmac = loginHmac(orgId, login);
  const counts = device ? !takeDeviceAllowance(device.deviceId, hmac, at) : true;

  // Transaction 1: take a try for this username (or refuse during a pause), and find the user.
  const attempt = await withTenant(orgId, async (db) => {
    const t = await takeTry(db, orgId, hmac, at, counts);
    const user = (await db.rows<UserRow>(
      `SELECT id, name, role_key AS "roleKey", active, password_hash AS "passwordHash",
              must_change_password AS "mustChange", switch_pin_hash IS NOT NULL AS "hasSwitchPin"
         FROM staff_users WHERE org_id = $1 AND login = $2`, [orgId, login]))[0];
    return { t, user };
  });
  const user = attempt.user;

  if (attempt.t.kind === 'paused') {
    recordIpFailure(ip, at);
    await audit(orgId, 'paused', user?.id ?? null);
    throw tooMany(attempt.t.pausedUntil, at);
  }
  const pauses = attempt.t.kind === 'counted' && attempt.t.pauses;
  const usable = user && user.active && user.passwordHash;
  const ok = usable ? await verifyPassword(input.password, user.passwordHash!) : (await dummyVerify(), false);
  if (!ok) {
    recordIpFailure(ip, at);
    const reason = !user ? 'unknown_login' : !user.active ? 'inactive' : !user.passwordHash ? 'no_password' : 'bad_password';
    await audit(orgId, reason, user?.id ?? null, { paused: pauses });
    if (pauses) throw tooMany(new Date(at.getTime() + PAUSE_MS), at);
    throw invalid();
  }
  const u = user!;

  // Transaction 2: clear the count, open the session, audit it: all or nothing.
  const session = await withTenant(orgId, async (db) => {
    await clearTries(db, orgId, hmac, at);
    // A full sign-in also clears a switch-PIN block (§3.3, §3.8).
    await db.rows(`UPDATE staff_users SET last_sign_in_at = $3, switch_pin_blocked = false, switch_pin_failures = 0,
                          switch_pin_window_from = NULL
                    WHERE org_id = $1 AND id = $2`, [orgId, u.id, at]);
    const settings = (await db.rows<{ reset: string }>('SELECT day_reset_time_ist::text AS reset FROM org_settings WHERE org_id = $1', [orgId]))[0];
    const expiresAt = sessionExpiry(at, settings?.reset ?? '04:00:00');
    if (device) {
      // Lock the device's state row first: a switch or a write on this PC waits for us.
      await db.rows(`INSERT INTO device_state (org_id, device_id, updated_at) VALUES ($1, $2, $3)
                     ON CONFLICT (org_id, device_id) DO NOTHING`, [orgId, device.deviceId, at]);
      await db.rows('SELECT 1 FROM device_state WHERE org_id = $1 AND device_id = $2 FOR UPDATE', [orgId, device.deviceId]);
      await db.rows(`UPDATE sessions SET revoked_at = $4, revoked_reason = 'replaced'
                      WHERE org_id = $1 AND staff_user_id = $2 AND device_id = $3 AND revoked_at IS NULL`,
        [orgId, u.id, device.deviceId, at]);
    }
    const s = (await db.rows<{ id: string }>(
      `INSERT INTO sessions (org_id, staff_user_id, device_id, method, created_at, expires_at, last_input_at)
       VALUES ($1, $2, $3, 'PASSWORD', $4, $5, $4) RETURNING id`, [orgId, u.id, device?.deviceId ?? null, at, expiresAt]))[0];
    if (device) {
      await db.rows('UPDATE device_state SET active_session_id = $3, updated_at = $4 WHERE org_id = $1 AND device_id = $2',
        [orgId, device.deviceId, s.id, at]);
      await db.rows('UPDATE devices SET last_seen_at = $3 WHERE org_id = $1 AND id = $2', [orgId, device.deviceId, at]);
    }
    await writeAudit(db, { orgId, action: 'auth.sign_in_succeeded', actorLabel: u.name, actorRole: u.roleKey,
      staffUserId: u.id, sessionId: s.id, deviceId: device?.deviceId ?? null, entityId: u.id,
      detail: device ? { method: 'password', device_id: device.deviceId } : { method: 'password' } });
    return { sid: s.id, expiresAt };
  });
  if (device) clearDeviceAllowance(device.deviceId, hmac);

  return {
    token: await signSessionToken(orgId, session.sid, session.expiresAt),
    expiresAt: session.expiresAt,
    next: u.mustChange ? '/account/password' : device && !u.hasSwitchPin ? '/account/switch-pin' : '/',
    deviceId: device?.deviceId ?? null,
    staleDeviceCookie,
  };
}
