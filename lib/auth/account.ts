import { withTenant } from '../db/tenant';
import { now } from '../clock';
import { HttpError, AuthError } from '../http/errors';
import { writeAudit } from '../audit';
import { hashPassword, passwordPolicy, verifyPassword } from './password';
import { revokeSession, type Session } from './guard';

/**
 * Account actions on the caller's own account (06a §3.7, §3.8; A-13, A-16).
 *
 * Signed-in secret tries count against the SESSION, never the account: a try is taken before
 * the secret is checked, a right secret gives its own try back, and the 5th wrong secret in a
 * session ends that session.
 */
const MAX_SECRET_TRIES = 5;

async function takeSecretTry(s: Session): Promise<number> {
  return withTenant(s.orgId, async (db) => {
    const r = await db.rows<{ n: number }>(
      `UPDATE sessions SET secret_failures = LEAST(secret_failures + 1, 5)
        WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING secret_failures AS n`, [s.orgId, s.sid]);
    if (!r[0]) throw new AuthError(401, 'session_revoked', 'This session has ended. Sign in again.');
    return r[0].n;
  });
}

export async function changePassword(s: Session, current: string, next: string): Promise<void> {
  const tries = await takeSecretTry(s);
  const user = await withTenant(s.orgId, async (db) => (await db.rows<{ hash: string | null; login: string; name: string }>(
    'SELECT password_hash AS hash, login, name FROM staff_users WHERE org_id = $1 AND id = $2', [s.orgId, s.staffUserId]))[0]);
  const ok = user.hash ? await verifyPassword(current, user.hash) : false;

  if (!ok) {
    if (tries >= MAX_SECRET_TRIES) {
      await withTenant(s.orgId, async (db) => {
        await revokeSession(db, s.orgId, s.sid, 'wrong_secrets');
        await writeAudit(db, { orgId: s.orgId, action: 'auth.session_ended', actorLabel: s.name, actorRole: s.roleKey,
          staffUserId: s.staffUserId, sessionId: s.sid, entityId: s.staffUserId, detail: { reason: 'wrong_secrets', kind: 'password' } });
      });
      throw new AuthError(401, 'session_revoked', 'Too many wrong passwords. This session has ended; sign in again.');
    }
    throw new AuthError(401, 'wrong_secret', 'The current password is wrong.', { remaining: MAX_SECRET_TRIES - tries });
  }
  const rule = passwordPolicy(next, { login: user.login, name: user.name });
  if (rule) {
    await giveBackTry(s);
    throw new HttpError(422, 'PASSWORD_POLICY', 'The new password does not meet the rules.', { rule });
  }
  const hash = await hashPassword(next);
  await withTenant(s.orgId, async (db) => {
    await db.rows('UPDATE sessions SET secret_failures = GREATEST(secret_failures - 1, 0) WHERE org_id = $1 AND id = $2', [s.orgId, s.sid]);
    await db.rows(`UPDATE staff_users SET password_hash = $3, must_change_password = false, password_failures = 0,
                          password_paused_until = NULL, updated_at = $4 WHERE org_id = $1 AND id = $2`,
      [s.orgId, s.staffUserId, hash, now()]);
    // §3.8 / desk rule: a password change ends the person's other sessions; this one stays.
    const ended = await db.rows<{ id: string }>(
      `UPDATE sessions SET revoked_at = $4, revoked_reason = 'password_changed'
        WHERE org_id = $1 AND staff_user_id = $2 AND id <> $3 AND revoked_at IS NULL RETURNING id`,
      [s.orgId, s.staffUserId, s.sid, now()]);
    await writeAudit(db, { orgId: s.orgId, action: 'auth.password_changed', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, entityId: s.staffUserId, detail: { count: ended.length } });
  });
}

async function giveBackTry(s: Session): Promise<void> {
  await withTenant(s.orgId, (db) => db.rows(
    'UPDATE sessions SET secret_failures = GREATEST(secret_failures - 1, 0) WHERE org_id = $1 AND id = $2', [s.orgId, s.sid]));
}

export async function signOut(s: Session): Promise<void> {
  await withTenant(s.orgId, async (db) => {
    await revokeSession(db, s.orgId, s.sid, 'sign_out');
    await writeAudit(db, { orgId: s.orgId, action: 'auth.sign_out', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, entityId: s.staffUserId });
  });
}

export async function revokeAllMySessions(s: Session): Promise<number> {
  return withTenant(s.orgId, async (db) => {
    const ended = await db.rows<{ id: string }>(
      `UPDATE sessions SET revoked_at = $3, revoked_reason = 'sign_out_all'
        WHERE org_id = $1 AND staff_user_id = $2 AND revoked_at IS NULL RETURNING id`, [s.orgId, s.staffUserId, now()]);
    await writeAudit(db, { orgId: s.orgId, action: 'auth.sessions_revoked', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, entityId: s.staffUserId, detail: { count: ended.length } });
    return ended.length;
  });
}
