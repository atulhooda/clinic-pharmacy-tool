import { withTenant } from '../db/tenant';
import type { Db } from '../db/db';
import { now } from '../clock';
import { AuthError } from '../http/errors';
import { readCookie } from '../http/cookies';
import { log } from '../log';
import { SESSION_COOKIE, readSessionToken } from './token';
import { DEVICE_COOKIE, readDeviceToken, type DeviceClaim } from './device';
import { effectivePermissions, holdsPinGatedPermission, type Permission } from './permissions';
import { writeAudit } from '../audit';
import { claimKey, completeKey, keyCommitted, keyRolledBack } from '../http/idempotency';

/**
 * The session guard (06a §3.4–3.6, route order step 2). Every request re-reads, in ONE query
 * inside withTenant(claims.org): the session, the user, the role and its overrides, the
 * premises memberships, the organisation's status and, on a trusted PC, the device and whose
 * session is active on it (06b DN-12). So deactivation, a role change, a membership change, a
 * suspension and a device revocation take effect on the next request.
 */
export interface Session {
  orgId: string;
  orgSlug: string;
  orgName: string;
  sid: string;
  staffUserId: string;
  name: string;
  roleKey: string;
  isOwner: boolean;
  permissions: ReadonlySet<Permission>;
  premises: { id: string; name: string }[];
  prescriberId: string | null;
  mustChangePassword: boolean;
  expiresAt: Date;
  /** The trusted PC this session is bound to (§3.5), or null for an untrusted browser. */
  deviceId: string | null;
  device: { id: string; name: string; premisesId: string } | null;
  /** When the PC locks without further input, and the setting behind it (trusted devices only). */
  lockAt: Date | null;
  lockMinutes: number | null;
  hasSwitchPin: boolean;
  hasSigningPin: boolean;
  /** Holds a PIN-gated permission but has no signing PIN yet (§3.7). */
  needsSigningPin: boolean;
}

export interface GuardOptions {
  /** The permission the route needs (403 forbidden without it). */
  permission?: Permission;
  /** Routes a person may use before changing a one-time password (§3.2, 06b DN-13). */
  allowMustChange?: boolean;
  /** Routes a person may use on a trusted PC before setting a switch PIN (§3.3, 06b DW-16). */
  allowNoSwitchPin?: boolean;
  /** Sign-out: works on a locked PC too (it only ends the caller's own session). */
  allowLocked?: boolean;
  /** A write counts as real input (§3.6). */
  mutating?: boolean;
}

interface Row {
  sid: string;
  staffUserId: string;
  deviceId: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  lastInputAt: Date;
  name: string;
  roleKey: string;
  active: boolean;
  mustChangePassword: boolean;
  prescriberId: string | null;
  hasSwitchPin: boolean;
  hasSigningPin: boolean;
  builtin: boolean;
  orgStatus: string;
  orgSlug: string;
  orgName: string;
  untrustedIdleMinutes: number | null;
  lockMinutes: number;
  deviceName: string | null;
  devicePremisesId: string | null;
  deviceRevokedAt: Date | null;
  activeSessionId: string | null;
  cookieDeviceTrusted: boolean | null;
  overrides: { permission: string; allowed: boolean }[];
  premises: { id: string; name: string }[];
}

const LOOKUP = `
  SELECT s.id AS sid, s.staff_user_id AS "staffUserId", s.device_id AS "deviceId", s.expires_at AS "expiresAt",
         s.revoked_at AS "revokedAt", s.last_input_at AS "lastInputAt",
         u.name, u.role_key AS "roleKey", u.active, u.must_change_password AS "mustChangePassword",
         u.prescriber_id AS "prescriberId", u.switch_pin_hash IS NOT NULL AS "hasSwitchPin",
         u.signing_pin_hash IS NOT NULL AS "hasSigningPin", r.builtin,
         o.status AS "orgStatus", o.slug AS "orgSlug", o.display_name AS "orgName",
         os.untrusted_idle_minutes AS "untrustedIdleMinutes", coalesce(os.device_lock_minutes, 3) AS "lockMinutes",
         d.name AS "deviceName", d.premises_id AS "devicePremisesId", d.revoked_at AS "deviceRevokedAt",
         ds.active_session_id AS "activeSessionId",
         (SELECT cd.revoked_at IS NULL FROM devices cd WHERE cd.org_id = s.org_id AND cd.id = $3::uuid) AS "cookieDeviceTrusted",
         coalesce((SELECT json_agg(json_build_object('permission', g.permission, 'allowed', g.allowed))
                     FROM role_grants g WHERE g.org_id = s.org_id AND g.role_key = u.role_key), '[]'::json) AS overrides,
         CASE WHEN u.role_key = 'owner' AND r.builtin THEN
           coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.name)
                       FROM premises p WHERE p.org_id = s.org_id AND p.active), '[]'::json)
         ELSE
           coalesce((SELECT json_agg(json_build_object('id', p.id, 'name', p.name) ORDER BY p.name)
                       FROM staff_premises sp JOIN premises p ON p.org_id = sp.org_id AND p.id = sp.premises_id
                      WHERE sp.org_id = s.org_id AND sp.staff_user_id = u.id AND sp.active AND p.active), '[]'::json)
         END AS premises
    FROM sessions s
    JOIN staff_users u ON u.org_id = s.org_id AND u.id = s.staff_user_id
    JOIN org_roles r ON r.org_id = u.org_id AND r.key = u.role_key
    JOIN organisations o ON o.id = s.org_id
    LEFT JOIN org_settings os ON os.org_id = s.org_id
    LEFT JOIN devices d ON d.org_id = s.org_id AND d.id = s.device_id
    LEFT JOIN device_state ds ON ds.org_id = s.org_id AND ds.device_id = s.device_id
   WHERE s.org_id = $1 AND s.id = $2`;

const unauthenticated = () => new AuthError(401, 'unauthenticated', 'Sign in first.');
const revoked = () => new AuthError(401, 'session_revoked', 'This session has ended. Sign in again.');
const expired = () => new AuthError(401, 'session_expired', 'Your session has ended for the day. Sign in again.');
export const deviceLocked = () => new AuthError(401, 'device_locked', 'This PC is locked. Pick your name and enter your switch PIN.');
const mismatch = () => new AuthError(401, 'device_mismatch', 'This session belongs to another PC. Sign in again here.');

export async function revokeSession(db: Db, orgId: string, sid: string, reason: string): Promise<void> {
  await db.rows('UPDATE sessions SET revoked_at = $3, revoked_reason = $4 WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL',
    [orgId, sid, now(), reason]);
}

/** Ends a device session's turn at the PC (logged, not audited: it happens many times a day, §3.5). */
export async function lockDevice(db: Db, orgId: string, deviceId: string, sid: string, reason: 'idle' | 'switch_person' | 'sign_out'): Promise<void> {
  const r = await db.rows(`UPDATE device_state SET active_session_id = NULL, updated_at = $4
                            WHERE org_id = $1 AND device_id = $2 AND active_session_id = $3 RETURNING id`, [orgId, deviceId, sid, now()]);
  if (r.length) log('device_locked', { deviceId, reason });
}

export async function sessionFromRequest(req: Request, opts: GuardOptions = {}): Promise<Session> {
  const cookie = req.headers.get('cookie');
  return sessionFromToken(readCookie(cookie, SESSION_COOKIE), await readDeviceToken(readCookie(cookie, DEVICE_COOKIE)),
    { ...opts, mutating: opts.mutating ?? (req.method !== 'GET' && req.method !== 'HEAD') });
}

export async function sessionFromToken(token: string | undefined, device: DeviceClaim | null, opts: GuardOptions = {}): Promise<Session> {
  if (!token) throw unauthenticated();
  const at = now();
  const claims = await readSessionToken(token, at);
  if (!claims.ok) {
    if (claims.expired) throw expired();
    throw unauthenticated();
  }
  const { org, sid } = claims;
  // A device cookie from another organisation can never match this session (06b DX-08).
  if (device && device.org !== org) throw mismatch();

  // One transaction: the lookup, then any revocation, lock or touch. Errors are raised after
  // commit, so a revocation or a lock is kept.
  const outcome = await withTenant(org, async (db): Promise<{ error?: AuthError; row?: Row }> => {
    const row = (await db.rows<Row>(LOOKUP, [org, sid, device?.deviceId ?? null]))[0];
    if (!row || row.revokedAt || row.orgStatus !== 'ACTIVE') return { error: revoked() };
    if (row.expiresAt.getTime() <= at.getTime()) {
      await revokeSession(db, org, sid, 'expired');
      return { error: expired() };
    }
    if (!row.active) {
      await revokeSession(db, org, sid, 'deactivated');
      return { error: revoked() };
    }
    const idleMs = at.getTime() - row.lastInputAt.getTime();
    if (row.deviceId) {
      // §3.5: a device session is accepted only with that device's cookie.
      if (!device || device.deviceId !== row.deviceId) return { error: mismatch() };
      if (row.deviceRevokedAt) {
        await revokeSession(db, org, sid, 'device_revoked');
        return { error: revoked() };
      }
      if (!opts.allowLocked) {
        // §3.5 point 4: one active person at a time.
        if (row.activeSessionId !== sid) return { error: deviceLocked() };
        // §3.6: the server decides, from last_input_at read BEFORE it is touched.
        if (idleMs > row.lockMinutes * 60_000) {
          await lockDevice(db, org, row.deviceId, sid, 'idle');
          return { error: deviceLocked() };
        }
      }
    } else {
      // §3.5: a browser holding a valid trusted-device cookie must use that device's session.
      if (device && row.cookieDeviceTrusted) return { error: mismatch() };
      // §3.4: untrusted browsers time out only if the organisation sets untrusted_idle_minutes.
      if (row.untrustedIdleMinutes !== null && idleMs > row.untrustedIdleMinutes * 60_000) {
        await revokeSession(db, org, sid, 'idle');
        await writeAudit(db, { orgId: org, action: 'auth.session_ended', actorLabel: row.name, actorRole: row.roleKey,
          staffUserId: row.staffUserId, sessionId: sid, entityId: row.staffUserId, detail: { reason: 'idle' } });
        return { error: new AuthError(401, 'session_idle', 'You were signed out after a period without activity.') };
      }
    }
    if (opts.mutating && idleMs > 5_000) {
      await db.rows('UPDATE sessions SET last_input_at = $3 WHERE org_id = $1 AND id = $2', [org, sid, at]);
      row.lastInputAt = at;
    }
    return { row };
  });
  if (outcome.error) throw outcome.error;
  const row = outcome.row!;

  const permissions = effectivePermissions(row.roleKey, row.builtin, row.overrides);
  if (row.mustChangePassword && !opts.allowMustChange) {
    throw new AuthError(403, 'password_change_required', 'Change your one-time password first.');
  }
  if (row.deviceId && !row.hasSwitchPin && !opts.allowNoSwitchPin) {
    throw new AuthError(403, 'switch_pin_required', 'Set your switch PIN for this PC first.');
  }
  if (opts.permission && !permissions.has(opts.permission)) {
    throw new AuthError(403, 'forbidden', 'You do not have permission to do this.');
  }
  return {
    orgId: org,
    orgSlug: row.orgSlug,
    orgName: row.orgName,
    sid,
    staffUserId: row.staffUserId,
    name: row.name,
    roleKey: row.roleKey,
    isOwner: row.roleKey === 'owner' && row.builtin,
    permissions,
    premises: row.premises,
    prescriberId: row.prescriberId,
    mustChangePassword: row.mustChangePassword,
    expiresAt: row.expiresAt,
    deviceId: row.deviceId,
    device: row.deviceId ? { id: row.deviceId, name: row.deviceName!, premisesId: row.devicePremisesId! } : null,
    lockAt: row.deviceId ? new Date(row.lastInputAt.getTime() + row.lockMinutes * 60_000) : null,
    lockMinutes: row.deviceId ? row.lockMinutes : null,
    hasSwitchPin: row.hasSwitchPin,
    hasSigningPin: row.hasSigningPin,
    needsSigningPin: !row.hasSigningPin && holdsPinGatedPermission(permissions),
  };
}

/**
 * A write's own transaction (§3.5 point 4, 06b DC-11). On a trusted PC it first reads the
 * device's state row FOR SHARE and checks this session is still the active one. A switch or a
 * lock updates that row, so it waits for this write to finish, and a write that starts after a
 * switch committed is refused. So no write ever commits under the previous person's name.
 */
export async function withSessionTx<T>(s: Pick<Session, 'orgId' | 'sid' | 'deviceId' | 'staffUserId'>, fn: (db: Db) => Promise<T>): Promise<T> {
  try {
    const out = await withTenant(s.orgId, async (db) => {
      if (s.deviceId) {
        const r = await db.rows<{ active: string | null }>(
          'SELECT active_session_id AS active FROM device_state WHERE org_id = $1 AND device_id = $2 FOR SHARE', [s.orgId, s.deviceId]);
        if (r[0]?.active !== s.sid) throw deviceLocked();
      }
      // 06a §12.2: a write request's key is claimed first in its business transaction and
      // completed in it, so only a committed success is remembered.
      await claimKey(db, s.orgId, s.staffUserId);
      const result = await fn(db);
      await completeKey(db, s.orgId, result);
      return result;
    });
    keyCommitted();
    return out;
  } catch (err) {
    keyRolledBack();
    throw err;
  }
}
