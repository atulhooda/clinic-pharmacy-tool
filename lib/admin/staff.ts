import type { Db } from '../db/db';
import { now } from '../clock';
import { HttpError } from '../http/errors';
import { writeAudit } from '../audit';
import { withSessionTx, type Session } from '../auth/guard';
import { consumeGrant } from '../auth/reauth';
import { hashPassword, oneTimePassword } from '../auth/password';
import { effectivePermissions, holdsPinGatedPermission } from '../auth/permissions';
import { loginHmac } from '../auth/throttle';

/**
 * Staff accounts (06a §3.2, §4.1; M-05 … M-08). Creating, editing and resetting need a
 * `staff.manage` grant: for the organisation on create, for the person otherwise (§3.7).
 *
 * - A role change ends the person's sessions (06b DN-10); deactivation does too (DN-09).
 * - The last active owner cannot be deactivated or demoted (409 last_owner, DN-18).
 * - Only an owner can give or take the owner role (R7-1).
 * - When a role change removes a person's last PIN-gated permission, their signing PIN is
 *   cleared in the same transaction (06a §3.7, 06b DPN-14).
 * - A one-time password is returned once and never logged or audited (DN-17).
 */
export interface StaffView {
  id: string;
  name: string;
  login: string;
  role: string;
  phone: string | null;
  prescriberId: string | null;
  active: boolean;
  mustChangePassword: boolean;
  hasSwitchPin: boolean;
  hasSigningPin: boolean;
  lastSignInAt: string | null;
  premisesIds: string[];
  openSessions: number;
}
interface Row extends Omit<StaffView, 'lastSignInAt'> { lastSignInAt: Date | null }

const SELECT = `
  SELECT u.id, u.name, u.login, u.role_key AS role, u.phone_e164 AS phone, u.prescriber_id AS "prescriberId", u.active,
         u.must_change_password AS "mustChangePassword", u.switch_pin_hash IS NOT NULL AS "hasSwitchPin",
         u.signing_pin_hash IS NOT NULL AS "hasSigningPin", u.last_sign_in_at AS "lastSignInAt",
         coalesce((SELECT array_agg(sp.premises_id ORDER BY sp.premises_id) FROM staff_premises sp
                    WHERE sp.org_id = u.org_id AND sp.staff_user_id = u.id AND sp.active), '{}') AS "premisesIds",
         (SELECT count(*) FROM sessions s WHERE s.org_id = u.org_id AND s.staff_user_id = u.id AND s.revoked_at IS NULL
             AND s.expires_at > $2)::int AS "openSessions"
    FROM staff_users u WHERE u.org_id = $1 AND u.system_kind IS NULL`;
const view = (r: Row): StaffView => ({ ...r, lastSignInAt: r.lastSignInAt?.toISOString() ?? null });
const notFound = () => new HttpError(404, 'STAFF_NOT_FOUND', 'No such person.');
const LOGIN = /^[a-z0-9._-]{3,32}$/;
const PHONE = /^\+[1-9][0-9]{7,14}$/;

export async function listStaff(s: Session): Promise<StaffView[]> {
  return withSessionTx(s, async (db) => (await db.rows<Row>(`${SELECT} ORDER BY u.active DESC, lower(u.name)`, [s.orgId, now()])).map(view));
}

export async function getStaff(s: Session, id: string): Promise<StaffView> {
  const r = await withSessionTx(s, async (db) => (await db.rows<Row>(`${SELECT} AND u.id = $3`, [s.orgId, now(), id]))[0]);
  if (!r) throw notFound();
  return view(r);
}

async function roleOf(db: Db, orgId: string, key: string): Promise<{ key: string; builtin: boolean; overrides: { permission: string; allowed: boolean }[] }> {
  const r = (await db.rows<{ key: string; builtin: boolean; overrides: { permission: string; allowed: boolean }[] }>(
    `SELECT r.key, r.builtin,
            coalesce((SELECT json_agg(json_build_object('permission', g.permission, 'allowed', g.allowed))
                        FROM role_grants g WHERE g.org_id = r.org_id AND g.role_key = r.key), '[]'::json) AS overrides
       FROM org_roles r WHERE r.org_id = $1 AND r.key = $2`, [orgId, key]))[0];
  if (!r) throw new HttpError(404, 'ROLE_NOT_FOUND', 'No such role.');
  return r;
}

async function checkPremises(db: Db, orgId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const found = await db.rows<{ id: string }>('SELECT id FROM premises WHERE org_id = $1 AND id = ANY($2::uuid[]) AND active', [orgId, ids]);
  if (found.length !== ids.length) throw new HttpError(404, 'PREMISES_NOT_FOUND', 'No such premises.');
}

async function checkPrescriber(db: Db, orgId: string, id: string | null | undefined): Promise<void> {
  if (!id) return;
  const r = await db.rows('SELECT 1 FROM prescribers WHERE org_id = $1 AND id = $2 AND active', [orgId, id]);
  if (r.length === 0) throw new HttpError(404, 'PRESCRIBER_NOT_FOUND', 'No such prescriber.');
}

/** Turn a unique violation into the right 409. */
function uniqueConflict(err: unknown): never {
  const c = (err as { code?: string; constraint?: string });
  if (c.code === '23505') {
    if (c.constraint === 'staff_users_login_key') throw new HttpError(409, 'LOGIN_TAKEN', 'Someone already has that login.');
    if (c.constraint === 'staff_users_name_key') throw new HttpError(409, 'NAME_TAKEN', 'Someone already has that name.');
    if (c.constraint === 'staff_users_phone_key') throw new HttpError(409, 'PHONE_TAKEN', 'Someone already has that phone number.');
    if (c.constraint === 'staff_users_prescriber_key') throw new HttpError(409, 'PRESCRIBER_TAKEN', 'That prescriber already has a login.');
  }
  throw err;
}

function ownerOnly(s: Session, ...roles: (string | undefined)[]): void {
  if (roles.includes('owner') && !s.isOwner) throw new HttpError(403, 'forbidden', 'Only an owner can give or take the owner role.');
}

async function activeOwners(db: Db, orgId: string): Promise<number> {
  return (await db.rows<{ n: number }>(`SELECT count(*)::int AS n FROM staff_users WHERE org_id = $1 AND role_key = 'owner' AND active`, [orgId]))[0].n;
}

async function endSessions(db: Db, orgId: string, staffId: string, reason: string): Promise<number> {
  const at = now();
  const ended = await db.rows<{ id: string }>(
    `UPDATE sessions SET revoked_at = $3, revoked_reason = $4 WHERE org_id = $1 AND staff_user_id = $2 AND revoked_at IS NULL RETURNING id`,
    [orgId, staffId, at, reason]);
  if (ended.length) {
    await db.rows('UPDATE device_state SET active_session_id = NULL, updated_at = $3 WHERE org_id = $1 AND active_session_id = ANY($2::uuid[])',
      [orgId, ended.map((e) => e.id), at]);
  }
  return ended.length;
}

export interface StaffCreate {
  name: string;
  login: string;
  role: string;
  premisesIds: string[];
  phone?: string | null;
  prescriberId?: string | null;
}

export async function createStaff(s: Session, input: StaffCreate, grantId: string | undefined): Promise<{ staff: StaffView; oneTimePassword: string }> {
  const login = input.login.trim().toLowerCase();
  if (!LOGIN.test(login)) throw new HttpError(422, 'FIELD_INVALID', 'A login is 3–32 lower-case letters, digits, dot, dash or underscore.', { field: 'login', rule: 'format' });
  if (input.phone && !PHONE.test(input.phone)) throw new HttpError(422, 'FIELD_INVALID', 'Phone numbers are in +91… form.', { field: 'phone', rule: 'format' });
  ownerOnly(s, input.role);
  const otp = oneTimePassword();
  const hash = await hashPassword(otp);
  const id = await withSessionTx(s, async (db) => {
    await consumeGrant(db, s, 'staff.manage', s.orgId, grantId);
    await roleOf(db, s.orgId, input.role);
    await checkPremises(db, s.orgId, input.premisesIds);
    await checkPrescriber(db, s.orgId, input.prescriberId);
    const at = now();
    const u = (await db.rows<{ id: string }>(
      `INSERT INTO staff_users (org_id, name, login, role_key, phone_e164, prescriber_id, password_hash, must_change_password, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $8) RETURNING id`,
      [s.orgId, input.name.trim(), login, input.role, input.phone ?? null, input.prescriberId ?? null, hash, at]).catch(uniqueConflict))[0];
    for (const p of input.premisesIds) {
      await db.rows('INSERT INTO staff_premises (org_id, staff_user_id, premises_id, created_at) VALUES ($1, $2, $3, $4)', [s.orgId, u.id, p, at]);
    }
    await writeAudit(db, { orgId: s.orgId, action: 'staff.created', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: u.id, detail: { role: input.role } });
    return u.id;
  });
  return { staff: await getStaff(s, id), oneTimePassword: otp };
}

export interface StaffPatch {
  name?: string;
  role?: string;
  premisesIds?: string[];
  phone?: string | null;
  prescriberId?: string | null;
  active?: boolean;
}

export async function patchStaff(s: Session, id: string, input: StaffPatch, grantId: string | undefined): Promise<StaffView> {
  if (input.phone && !PHONE.test(input.phone)) throw new HttpError(422, 'FIELD_INVALID', 'Phone numbers are in +91… form.', { field: 'phone', rule: 'format' });
  await withSessionTx(s, async (db) => {
    const cur = (await db.rows<{ name: string; role: string; phone: string | null; prescriberId: string | null; active: boolean }>(
      `SELECT name, role_key AS role, phone_e164 AS phone, prescriber_id AS "prescriberId", active
         FROM staff_users WHERE org_id = $1 AND id = $2 AND system_kind IS NULL FOR UPDATE`, [s.orgId, id]))[0];
    if (!cur) throw notFound();
    await consumeGrant(db, s, 'staff.manage', id, grantId);
    const at = now();
    const fields: string[] = [];
    const roleChanged = input.role !== undefined && input.role !== cur.role;
    const deactivating = input.active === false && cur.active;
    if (roleChanged) ownerOnly(s, cur.role, input.role);
    // §4.1: the organisation can never lose its last active owner.
    if (cur.role === 'owner' && cur.active && (roleChanged || deactivating) && (await activeOwners(db, s.orgId)) <= 1) {
      throw new HttpError(409, 'last_owner', 'This is the only active owner. Make someone else an owner first.');
    }
    if (input.name !== undefined && input.name.trim() !== cur.name) fields.push('name');
    if (input.phone !== undefined && input.phone !== cur.phone) fields.push('phone');
    if (input.prescriberId !== undefined && input.prescriberId !== cur.prescriberId) {
      await checkPrescriber(db, s.orgId, input.prescriberId);
      fields.push('prescriber_id');
    }
    if (input.active !== undefined && input.active !== cur.active) fields.push('active');
    if (roleChanged) {
      const role = await roleOf(db, s.orgId, input.role!);
      fields.push('role');
      // §3.7: losing the last PIN-gated permission clears the signing PIN, in this transaction.
      if (!holdsPinGatedPermission(effectivePermissions(role.key, role.builtin, role.overrides))) {
        const cleared = await db.rows(`UPDATE staff_users SET signing_pin_hash = NULL WHERE org_id = $1 AND id = $2 AND signing_pin_hash IS NOT NULL RETURNING id`, [s.orgId, id]);
        if (cleared.length) {
          await writeAudit(db, { orgId: s.orgId, action: 'staff.signing_pin_cleared', actorLabel: s.name, actorRole: s.roleKey,
            staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: id, detail: { reason: 'role_changed' } });
        }
      }
    }
    await db.rows(
      `UPDATE staff_users SET name = $3, role_key = $4, phone_e164 = $5, prescriber_id = $6, active = $7, updated_at = $8
        WHERE org_id = $1 AND id = $2`,
      [s.orgId, id, input.name?.trim() ?? cur.name, input.role ?? cur.role, input.phone === undefined ? cur.phone : input.phone,
        input.prescriberId === undefined ? cur.prescriberId : input.prescriberId, input.active ?? cur.active, at]).catch(uniqueConflict);
    if (input.premisesIds) {
      await checkPremises(db, s.orgId, input.premisesIds);
      const before = (await db.rows<{ p: string }>(
        'SELECT premises_id AS p FROM staff_premises WHERE org_id = $1 AND staff_user_id = $2 AND active', [s.orgId, id])).map((r) => r.p).sort();
      const after = [...input.premisesIds].sort();
      if (before.join() !== after.join()) {
        await db.rows('UPDATE staff_premises SET active = (premises_id = ANY($3::uuid[])) WHERE org_id = $1 AND staff_user_id = $2', [s.orgId, id, after]);
        for (const p of after.filter((x) => !before.includes(x))) {
          await db.rows(`INSERT INTO staff_premises (org_id, staff_user_id, premises_id, created_at) VALUES ($1, $2, $3, $4)
                         ON CONFLICT (org_id, staff_user_id, premises_id) DO UPDATE SET active = true`, [s.orgId, id, p, at]);
        }
        fields.push('premises');
      }
    }
    if (fields.length === 0) return;
    if (roleChanged) {
      const n = await endSessions(db, s.orgId, id, 'role_changed');
      await writeAudit(db, { orgId: s.orgId, action: 'staff.role_changed', actorLabel: s.name, actorRole: s.roleKey,
        staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: id, detail: { from: cur.role, to: input.role, count: n } });
    }
    if (deactivating) {
      const n = await endSessions(db, s.orgId, id, 'deactivated');
      await writeAudit(db, { orgId: s.orgId, action: 'staff.deactivated', actorLabel: s.name, actorRole: s.roleKey,
        staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: id, detail: { count: n } });
    }
    const other = fields.filter((f) => f !== 'role' && !(f === 'active' && deactivating));
    if (other.length) {
      await writeAudit(db, { orgId: s.orgId, action: 'staff.changed', actorLabel: s.name, actorRole: s.roleKey,
        staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: id, detail: { fields: other } });
    }
  });
  return getStaff(s, id);
}

/**
 * M-07: a new one-time password, returned once; both PINs cleared; every session ended; the
 * person's sign-in count and pause cleared (it is the owner's unlock).
 */
export async function resetStaff(s: Session, id: string, grantId: string | undefined): Promise<{ oneTimePassword: string }> {
  const otp = oneTimePassword();
  const hash = await hashPassword(otp);
  await withSessionTx(s, async (db) => {
    const cur = (await db.rows<{ role: string; login: string }>('SELECT role_key AS role, login FROM staff_users WHERE org_id = $1 AND id = $2 AND system_kind IS NULL FOR UPDATE', [s.orgId, id]))[0];
    if (!cur) throw notFound();
    ownerOnly(s, cur.role);
    await consumeGrant(db, s, 'staff.manage', id, grantId);
    await db.rows(`UPDATE staff_users SET password_hash = $3, must_change_password = true, switch_pin_hash = NULL, signing_pin_hash = NULL,
                          switch_pin_failures = 0, switch_pin_window_from = NULL, switch_pin_blocked = false, updated_at = $4
                    WHERE org_id = $1 AND id = $2`, [s.orgId, id, hash, now()]);
    await db.rows('UPDATE sign_in_throttle SET failures = 0, window_from = NULL, paused_until = NULL WHERE org_id = $1 AND login_hmac = $2',
      [s.orgId, loginHmac(s.orgId, cur.login)]);
    const n = await endSessions(db, s.orgId, id, 'password_reset');
    await writeAudit(db, { orgId: s.orgId, action: 'staff.password_reset', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: id, detail: { count: n } });
  });
  return { oneTimePassword: otp };
}

/** M-08: end every session of this person (no grant needed). */
export async function revokeStaffSessions(s: Session, id: string): Promise<{ ended: number }> {
  return withSessionTx(s, async (db) => {
    const cur = await db.rows('SELECT 1 FROM staff_users WHERE org_id = $1 AND id = $2 AND system_kind IS NULL', [s.orgId, id]);
    if (cur.length === 0) throw notFound();
    const n = await endSessions(db, s.orgId, id, 'owner_revoked');
    await writeAudit(db, { orgId: s.orgId, action: 'staff.sessions_revoked', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: id, detail: { count: n } });
    return { ended: n };
  });
}
