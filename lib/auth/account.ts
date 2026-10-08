import { withTenant } from '../db/tenant';
import type { Db } from '../db/db';
import { now } from '../clock';
import { HttpError, AuthError } from '../http/errors';
import { writeAudit } from '../audit';
import { hashPassword, passwordPolicy, verifyPassword } from './password';
import { hashPin, pinFormatOk, verifyPin } from './pins';
import { holdsPinGatedPermission } from './permissions';
import { revokeSession, lockDevice, withSessionTx, type Session } from './guard';

/**
 * Account actions on the caller's own account (06a §3.7, §3.8; A-13 … A-16).
 *
 * Signed-in secret tries count against the SESSION, never the account: a try is taken before
 * the secret is checked, a right secret gives its own try back, and the 5th wrong secret in a
 * session ends that session.
 */
const MAX_SECRET_TRIES = 5;

export async function takeSecretTry(s: Session): Promise<number> {
  return withTenant(s.orgId, async (db) => {
    const r = await db.rows<{ n: number }>(
      `UPDATE sessions SET secret_failures = LEAST(secret_failures + 1, 5)
        WHERE org_id = $1 AND id = $2 AND revoked_at IS NULL RETURNING secret_failures AS n`, [s.orgId, s.sid]);
    if (!r[0]) throw new AuthError(401, 'session_revoked', 'This session has ended. Sign in again.');
    return r[0].n;
  });
}

export async function giveBackTry(db: Db, s: Session): Promise<void> {
  await db.rows('UPDATE sessions SET secret_failures = GREATEST(secret_failures - 1, 0) WHERE org_id = $1 AND id = $2', [s.orgId, s.sid]);
}

/** A wrong secret: 401 wrong_secret with the tries left, or, on the 5th, the session ends. */
export async function wrongSecret(s: Session, tries: number, kind: string): Promise<never> {
  if (tries >= MAX_SECRET_TRIES) {
    await withTenant(s.orgId, async (db) => {
      await revokeSession(db, s.orgId, s.sid, 'wrong_secrets');
      if (s.deviceId) await lockDevice(db, s.orgId, s.deviceId, s.sid, 'sign_out');
      await writeAudit(db, { orgId: s.orgId, action: 'auth.session_ended', actorLabel: s.name, actorRole: s.roleKey,
        staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: s.staffUserId,
        detail: { reason: 'wrong_secrets', kind } });
    });
    throw new AuthError(401, 'session_revoked', 'Too many wrong tries. This session has ended; sign in again.');
  }
  throw new AuthError(401, 'wrong_secret', 'That is not right.', { remaining: MAX_SECRET_TRIES - tries });
}

async function storedSecrets(s: Session) {
  return withTenant(s.orgId, async (db) => (await db.rows<{ password: string | null; switchPin: string | null; signingPin: string | null; login: string; name: string }>(
    `SELECT password_hash AS password, switch_pin_hash AS "switchPin", signing_pin_hash AS "signingPin", login, name
       FROM staff_users WHERE org_id = $1 AND id = $2`, [s.orgId, s.staffUserId]))[0]);
}

export async function changePassword(s: Session, current: string, next: string): Promise<void> {
  const tries = await takeSecretTry(s);
  const user = await storedSecrets(s);
  const ok = user.password ? await verifyPassword(current, user.password) : false;
  if (!ok) await wrongSecret(s, tries, 'password');

  const rule = passwordPolicy(next, { login: user.login, name: user.name });
  if (rule) {
    await withTenant(s.orgId, (db) => giveBackTry(db, s));
    throw new HttpError(422, 'PASSWORD_POLICY', 'The new password does not meet the rules.', { rule });
  }
  const hash = await hashPassword(next);
  await withSessionTx(s, async (db) => {
    await giveBackTry(db, s);
    await db.rows(`UPDATE staff_users SET password_hash = $3, must_change_password = false, updated_at = $4 WHERE org_id = $1 AND id = $2`,
      [s.orgId, s.staffUserId, hash, now()]);
    // §3.8 / desk rule: a password change ends the person's other sessions; this one stays.
    const ended = await db.rows<{ id: string }>(
      `UPDATE sessions SET revoked_at = $4, revoked_reason = 'password_changed'
        WHERE org_id = $1 AND staff_user_id = $2 AND id <> $3 AND revoked_at IS NULL RETURNING id`,
      [s.orgId, s.staffUserId, s.sid, now()]);
    await writeAudit(db, { orgId: s.orgId, action: 'auth.password_changed', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: s.staffUserId, detail: { count: ended.length } });
  });
}

/** A-14: set or change my switch PIN. It can never equal my signing PIN (§3.7). */
export async function setSwitchPin(s: Session, pin: string): Promise<void> {
  if (!pinFormatOk(pin)) throw new HttpError(422, 'PIN_FORMAT', 'A PIN is 6 digits, not all the same and not a straight run.');
  const user = await storedSecrets(s);
  if (user.signingPin && (await verifyPin(pin, user.signingPin)).ok) {
    throw new HttpError(422, 'PIN_SAME_AS_OTHER', 'Your switch PIN must differ from your signing PIN.');
  }
  const hash = await hashPin(pin);
  await withSessionTx(s, async (db) => {
    await db.rows('UPDATE staff_users SET switch_pin_hash = $3, updated_at = $4 WHERE org_id = $1 AND id = $2', [s.orgId, s.staffUserId, hash, now()]);
    await writeAudit(db, { orgId: s.orgId, action: 'auth.pin_set', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: s.staffUserId, detail: { kind: 'switch' } });
  });
}

/**
 * A-15: set or change my signing PIN. It is a signature, so the request carries a fresh full
 * credential (the password; an OTP in Milestone 2). Only people whose role holds a PIN-gated
 * permission get one (D-33).
 */
export async function setSigningPin(s: Session, pin: string, password: string | undefined): Promise<void> {
  if (!holdsPinGatedPermission(s.permissions)) {
    throw new AuthError(403, 'signing_pin_not_applicable', 'Your role has no action that needs a signing PIN.');
  }
  if (!password) throw new HttpError(422, 'CREDENTIAL_REQUIRED', 'Enter your password to set a signing PIN.');
  if (!pinFormatOk(pin)) throw new HttpError(422, 'PIN_FORMAT', 'A PIN is 6 digits, not all the same and not a straight run.');
  const tries = await takeSecretTry(s);
  const user = await storedSecrets(s);
  if (!(user.password && (await verifyPassword(password, user.password)))) await wrongSecret(s, tries, 'password');
  if (user.switchPin && (await verifyPin(pin, user.switchPin)).ok) {
    await withTenant(s.orgId, (db) => giveBackTry(db, s));
    throw new HttpError(422, 'PIN_SAME_AS_OTHER', 'Your signing PIN must differ from your switch PIN.');
  }
  const hash = await hashPin(pin);
  await withSessionTx(s, async (db) => {
    await giveBackTry(db, s);
    await db.rows('UPDATE staff_users SET signing_pin_hash = $3, updated_at = $4 WHERE org_id = $1 AND id = $2', [s.orgId, s.staffUserId, hash, now()]);
    await writeAudit(db, { orgId: s.orgId, action: 'auth.pin_set', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: s.staffUserId, detail: { kind: 'signing' } });
  });
}

export async function signOut(s: Session): Promise<void> {
  await withTenant(s.orgId, async (db) => {
    await revokeSession(db, s.orgId, s.sid, 'sign_out');
    if (s.deviceId) await lockDevice(db, s.orgId, s.deviceId, s.sid, 'sign_out');
    await writeAudit(db, { orgId: s.orgId, action: 'auth.sign_out', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: s.staffUserId });
  });
}

export async function revokeAllMySessions(s: Session): Promise<number> {
  return withSessionTx(s, async (db) => {
    const ended = await db.rows<{ id: string }>(
      `UPDATE sessions SET revoked_at = $3, revoked_reason = 'sign_out_all'
        WHERE org_id = $1 AND staff_user_id = $2 AND revoked_at IS NULL RETURNING id`, [s.orgId, s.staffUserId, now()]);
    await db.rows(`UPDATE device_state SET active_session_id = NULL, updated_at = $3
                    WHERE org_id = $1 AND active_session_id = ANY($2::uuid[])`, [s.orgId, ended.map((e) => e.id), now()]);
    await writeAudit(db, { orgId: s.orgId, action: 'auth.sessions_revoked', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: s.staffUserId, detail: { count: ended.length } });
    return ended.length;
  });
}
