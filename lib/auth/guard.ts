import { withTenant } from '../db/tenant';
import type { Db } from '../db/db';
import { now } from '../clock';
import { AuthError } from '../http/errors';
import { readCookie } from '../http/cookies';
import { SESSION_COOKIE, readSessionToken } from './token';
import { effectivePermissions, type Permission } from './permissions';
import { writeAudit } from '../audit';

/**
 * The session guard (06a §3.4, route order step 2). Every request re-reads, in ONE query
 * inside withTenant(claims.org): the session, the user, the role and its overrides, the
 * premises memberships and the organisation's status (06b DN-12). So deactivation, a role
 * change, a membership change or a suspension takes effect on the next request.
 * The device lock (§3.5, §3.6) is added in PR 3.
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
  deviceId: string | null;
  mustChangePassword: boolean;
  expiresAt: Date;
}

export interface GuardOptions {
  /** The permission the route needs (403 forbidden without it). */
  permission?: Permission;
  /** Routes a person may use before changing a one-time password (§3.2, 06b DN-13). */
  allowMustChange?: boolean;
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
  builtin: boolean;
  orgStatus: string;
  orgSlug: string;
  orgName: string;
  untrustedIdleMinutes: number | null;
  overrides: { permission: string; allowed: boolean }[];
  premises: { id: string; name: string }[];
}

const LOOKUP = `
  SELECT s.id AS sid, s.staff_user_id AS "staffUserId", s.device_id AS "deviceId", s.expires_at AS "expiresAt",
         s.revoked_at AS "revokedAt", s.last_input_at AS "lastInputAt",
         u.name, u.role_key AS "roleKey", u.active, u.must_change_password AS "mustChangePassword",
         u.prescriber_id AS "prescriberId", r.builtin,
         o.status AS "orgStatus", o.slug AS "orgSlug", o.display_name AS "orgName",
         os.untrusted_idle_minutes AS "untrustedIdleMinutes",
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
   WHERE s.org_id = $1 AND s.id = $2`;

const unauthenticated = () => new AuthError(401, 'unauthenticated', 'Sign in first.');
const revoked = () => new AuthError(401, 'session_revoked', 'This session has ended. Sign in again.');

export async function revokeSession(db: Db, orgId: string, sid: string, reason: string): Promise<void> {
  await db.rows('UPDATE sessions SET revoked_at = $3, revoked_reason = $4 WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL',
    [orgId, sid, now(), reason]);
}

export async function sessionFromRequest(req: Request, opts: GuardOptions = {}): Promise<Session> {
  const token = readCookie(req.headers.get('cookie'), SESSION_COOKIE);
  return sessionFromToken(token, { ...opts, mutating: opts.mutating ?? (req.method !== 'GET' && req.method !== 'HEAD') });
}

export async function sessionFromToken(token: string | undefined, opts: GuardOptions = {}): Promise<Session> {
  if (!token) throw unauthenticated();
  const at = now();
  const claims = await readSessionToken(token, at);
  if (!claims.ok) {
    if (claims.expired) throw new AuthError(401, 'session_expired', 'Your session has ended for the day. Sign in again.');
    throw unauthenticated();
  }
  const { org, sid } = claims;

  // One transaction: the lookup, then any revocation or touch. Errors are raised after commit,
  // so a revocation is kept.
  const outcome = await withTenant(org, async (db): Promise<{ error?: AuthError; row?: Row }> => {
    const row = (await db.rows<Row>(LOOKUP, [org, sid]))[0];
    if (!row || row.revokedAt || row.orgStatus !== 'ACTIVE') return { error: revoked() };
    if (row.expiresAt.getTime() <= at.getTime()) {
      await revokeSession(db, org, sid, 'expired');
      return { error: new AuthError(401, 'session_expired', 'Your session has ended for the day. Sign in again.') };
    }
    if (!row.active) {
      await revokeSession(db, org, sid, 'deactivated');
      return { error: revoked() };
    }
    // §3.4: untrusted browsers time out only if the organisation sets untrusted_idle_minutes.
    if (!row.deviceId && row.untrustedIdleMinutes !== null
        && at.getTime() - row.lastInputAt.getTime() > row.untrustedIdleMinutes * 60_000) {
      await revokeSession(db, org, sid, 'idle');
      await writeAudit(db, { orgId: org, action: 'auth.session_ended', actorLabel: row.name, actorRole: row.roleKey,
        staffUserId: row.staffUserId, sessionId: sid, entityId: row.staffUserId, detail: { reason: 'idle' } });
      return { error: new AuthError(401, 'session_idle', 'You were signed out after a period without activity.') };
    }
    if (opts.mutating && at.getTime() - row.lastInputAt.getTime() > 30_000) {
      await db.rows('UPDATE sessions SET last_input_at = $3 WHERE org_id = $1 AND id = $2', [org, sid, at]);
    }
    return { row };
  });
  if (outcome.error) throw outcome.error;
  const row = outcome.row!;

  const permissions = effectivePermissions(row.roleKey, row.builtin, row.overrides);
  if (row.mustChangePassword && !opts.allowMustChange) {
    throw new AuthError(403, 'password_change_required', 'Change your one-time password first.');
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
    deviceId: row.deviceId,
    mustChangePassword: row.mustChangePassword,
    expiresAt: row.expiresAt,
  };
}
