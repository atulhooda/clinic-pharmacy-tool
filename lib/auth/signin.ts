import { withTenant } from '../db/tenant';
import { resolveOrgBySlug } from '../db/orgs';
import { now } from '../clock';
import { HttpError, AuthError } from '../http/errors';
import { writeAudit, auditBestEffort } from '../audit';
import { dummyVerify, verifyPassword } from './password';
import { ipRetryAfter, recordIpFailure } from './limits';
import { sessionExpiry } from './expiry';
import { signSessionToken } from './token';

/**
 * Password sign-in (06a §3.3, §3.8; Milestone 1 has no OTP, D-39).
 *
 * The lockout counts a try BEFORE the password is checked, under a row lock, so a burst of
 * parallel guesses checks at most five (06b DN-04). A paused account answers exactly like a
 * wrong password, and a pause never ends a live session. Unknown logins run a dummy scrypt
 * check, so timing does not reveal which logins exist. The typed login is never logged.
 */
const PAUSE_MS = 15 * 60 * 1000;
const MAX_TRIES = 5;

const invalid = () => new AuthError(401, 'invalid_credentials',
  'Wrong login or password. After 5 wrong tries, password sign-in pauses for 15 minutes.');

export interface SignInResult {
  token: string;
  expiresAt: Date;
  next: string;
}

interface UserRow {
  id: string;
  name: string;
  roleKey: string;
  active: boolean;
  passwordHash: string | null;
  failures: number;
  pausedUntil: Date | null;
  mustChange: boolean;
}

export async function signInWithPassword(input: { orgSlug: string; login: string; password: string }, ip: string): Promise<SignInResult> {
  const at = now();
  const retry = ipRetryAfter(ip, at);
  if (retry > 0) {
    throw new HttpError(429, 'too_many_attempts', 'Too many attempts from this network. Try again in a few minutes.',
      undefined, { 'retry-after': String(retry) });
  }
  const fail = async (orgId: string | null, reason: string, staffUserId?: string, extra: Record<string, unknown> = {}) => {
    recordIpFailure(ip, at);
    if (orgId) {
      await auditBestEffort({ orgId, action: 'auth.sign_in_failed', actorLabel: 'unknown', actorRole: 'anonymous',
        staffUserId: staffUserId ?? null, entityId: staffUserId ?? null, detail: { method: 'password', reason, ...extra } });
    }
    return invalid();
  };

  const org = await resolveOrgBySlug(input.orgSlug);
  if (!org) {
    await dummyVerify();
    throw await fail(null, 'unknown_org');
  }
  const login = input.login.trim().toLowerCase();

  // Transaction 1: find the login and take a try (or refuse without checking).
  const attempt = await withTenant(org.id, async (db) => {
    const u = (await db.rows<UserRow>(
      `SELECT id, name, role_key AS "roleKey", active, password_hash AS "passwordHash", password_failures AS failures,
              password_paused_until AS "pausedUntil", must_change_password AS "mustChange"
         FROM staff_users WHERE org_id = $1 AND login = $2 FOR UPDATE`, [org.id, login]))[0];
    if (!u) return { kind: 'unknown_login' as const };
    if (!u.active) return { kind: 'inactive' as const, u };
    if (!u.passwordHash) return { kind: 'no_password' as const, u };
    if (u.pausedUntil && u.pausedUntil.getTime() > at.getTime()) return { kind: 'paused' as const, u };
    const failures = (u.pausedUntil ? 0 : u.failures) + 1; // a lapsed pause starts a fresh count
    const pauses = failures >= MAX_TRIES;
    await db.rows('UPDATE staff_users SET password_failures = $3, password_paused_until = $4 WHERE org_id = $1 AND id = $2',
      [org.id, u.id, pauses ? 0 : failures, pauses ? new Date(at.getTime() + PAUSE_MS) : null]);
    return { kind: 'try' as const, u, pauses };
  });

  if (attempt.kind !== 'try') {
    await dummyVerify();
    throw await fail(org.id, attempt.kind, attempt.kind === 'unknown_login' ? undefined : attempt.u.id);
  }
  const u = attempt.u;
  if (!(await verifyPassword(input.password, u.passwordHash!))) {
    throw await fail(org.id, 'bad_password', u.id, { paused: attempt.pauses });
  }

  // Transaction 2: reset the counter, open the session, audit it, all or nothing.
  const session = await withTenant(org.id, async (db) => {
    await db.rows(`UPDATE staff_users SET password_failures = 0, password_paused_until = NULL, last_sign_in_at = $3
                    WHERE org_id = $1 AND id = $2`, [org.id, u.id, at]);
    const settings = (await db.rows<{ reset: string }>('SELECT day_reset_time_ist::text AS reset FROM org_settings WHERE org_id = $1', [org.id]))[0];
    const expiresAt = sessionExpiry(at, settings?.reset ?? '04:00:00');
    const s = (await db.rows<{ id: string }>(
      `INSERT INTO sessions (org_id, staff_user_id, device_id, method, created_at, expires_at, last_input_at)
       VALUES ($1, $2, NULL, 'PASSWORD', $3, $4, $3) RETURNING id`, [org.id, u.id, at, expiresAt]))[0];
    await writeAudit(db, { orgId: org.id, action: 'auth.sign_in_succeeded', actorLabel: u.name, actorRole: u.roleKey,
      staffUserId: u.id, sessionId: s.id, entityId: u.id, detail: { method: 'password' } });
    return { sid: s.id, expiresAt };
  });

  return {
    token: await signSessionToken(org.id, session.sid, session.expiresAt),
    expiresAt: session.expiresAt,
    next: u.mustChange ? '/account/password' : '/',
  };
}
