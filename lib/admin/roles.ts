import type { Db } from '../db/db';
import { now } from '../clock';
import { HttpError } from '../http/errors';
import { writeAudit } from '../audit';
import { withSessionTx, type Session } from '../auth/guard';
import { consumeGrant } from '../auth/reauth';
import { PERMISSIONS, OWNER_LOCKED, BUILTIN_ROLES, effectivePermissions, holdsPinGatedPermission, isPermission, type Permission } from '../auth/permissions';

/**
 * Roles as data, defaults in code (06a §4.1; M-09). Built-in roles keep their code defaults;
 * overrides and custom roles are rows. Every change is audited in the same transaction
 * (`role.created`, `role.changed`, one `role.grant_changed {role, permission, from, to}` per
 * permission). Writes need a `roles.manage` grant for the organisation (§3.7).
 *
 * - The owner can never lose staff.manage, roles.manage or org.settings (422 OWNER_GRANT_LOCKED).
 * - When a change leaves a role with no PIN-gated permission, its members' signing PINs are
 *   cleared in the same transaction, audited (§3.7, 06b DPN-14).
 * - Grant changes take effect on each member's next request (the guard re-reads them); no
 *   session ends.
 */
export interface RoleView {
  key: string;
  name: string;
  builtin: boolean;
  members: number;
  permissions: Permission[];
  overrides: Record<string, boolean>;
}
interface Row { key: string; name: string; builtin: boolean; members: number; overrides: { permission: string; allowed: boolean }[] }
const SELECT = `
  SELECT r.key, r.name, r.builtin,
         (SELECT count(*)::int FROM staff_users u WHERE u.org_id = r.org_id AND u.role_key = r.key AND u.active) AS members,
         coalesce((SELECT json_agg(json_build_object('permission', g.permission, 'allowed', g.allowed) ORDER BY g.permission)
                     FROM role_grants g WHERE g.org_id = r.org_id AND g.role_key = r.key), '[]'::json) AS overrides
    FROM org_roles r WHERE r.org_id = $1`;
const view = (r: Row): RoleView => ({
  key: r.key, name: r.name, builtin: r.builtin, members: r.members,
  permissions: [...effectivePermissions(r.key, r.builtin, r.overrides)].sort(),
  overrides: Object.fromEntries(r.overrides.map((o) => [o.permission, o.allowed])),
});
const KEY = /^[a-z][a-z0-9_]{1,31}$/;

export async function listRoles(s: Session): Promise<RoleView[]> {
  return withSessionTx(s, async (db) => (await db.rows<Row>(`${SELECT} ORDER BY r.builtin DESC, r.key`, [s.orgId])).map(view));
}

function checkGrants(grants: Record<string, boolean>): void {
  for (const k of Object.keys(grants)) {
    if (!isPermission(k)) throw new HttpError(422, 'UNKNOWN_PERMISSION', 'That permission does not exist.', { permission: k.slice(0, 64).replace(/[^a-z0-9_.]/g, '') });
  }
}

async function applyGrants(db: Db, s: Session, role: Row, grants: Record<string, boolean>): Promise<number> {
  const before = effectivePermissions(role.key, role.builtin, role.overrides);
  const at = now();
  let changed = 0;
  for (const [permission, allowed] of Object.entries(grants)) {
    const existing = role.overrides.find((o) => o.permission === permission);
    if (existing?.allowed === allowed) continue;
    await db.rows(`INSERT INTO role_grants (org_id, role_key, permission, allowed, updated_by, updated_at) VALUES ($1, $2, $3, $4, $5, $6)
                   ON CONFLICT (org_id, role_key, permission) DO UPDATE SET allowed = EXCLUDED.allowed, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
      [s.orgId, role.key, permission, allowed, s.staffUserId, at]);
    const from = before.has(permission as Permission);
    if (from !== allowed) {
      await writeAudit(db, { orgId: s.orgId, action: 'role.grant_changed', actorLabel: s.name, actorRole: s.roleKey,
        staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: s.orgId,
        detail: { role: role.key, permission, from, to: allowed } });
      changed++;
    }
  }
  // §3.7: a role left without any PIN-gated permission loses its members' signing PINs.
  const overrides = [...role.overrides.filter((o) => !(o.permission in grants)), ...Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed }))];
  if (holdsPinGatedPermission(before) && !holdsPinGatedPermission(effectivePermissions(role.key, role.builtin, overrides))) {
    const cleared = await db.rows<{ id: string }>(
      `UPDATE staff_users SET signing_pin_hash = NULL WHERE org_id = $1 AND role_key = $2 AND signing_pin_hash IS NOT NULL RETURNING id`, [s.orgId, role.key]);
    for (const c of cleared) {
      await writeAudit(db, { orgId: s.orgId, action: 'staff.signing_pin_cleared', actorLabel: s.name, actorRole: s.roleKey,
        staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: c.id, detail: { reason: 'role_changed', role: role.key } });
    }
  }
  return changed;
}

export async function createRole(s: Session, input: { key: string; name: string; grants: Record<string, boolean> }, grantId: string | undefined): Promise<RoleView> {
  const key = input.key.trim().toLowerCase();
  if (!KEY.test(key)) throw new HttpError(422, 'FIELD_INVALID', 'A role key is 2–32 lower-case letters, digits or underscores.', { field: 'key', rule: 'format' });
  checkGrants(input.grants);
  return withSessionTx(s, async (db) => {
    await consumeGrant(db, s, 'roles.manage', s.orgId, grantId);
    const taken = await db.rows('SELECT 1 FROM org_roles WHERE org_id = $1 AND key = $2', [s.orgId, key]);
    if (taken.length || (BUILTIN_ROLES as readonly string[]).includes(key)) throw new HttpError(409, 'ROLE_KEY_TAKEN', 'A role with that key exists.');
    await db.rows('INSERT INTO org_roles (org_id, key, name, created_at) VALUES ($1, $2, $3, $4)', [s.orgId, key, input.name.trim(), now()]);
    await writeAudit(db, { orgId: s.orgId, action: 'role.created', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: s.orgId, detail: { role: key } });
    const role: Row = { key, name: input.name.trim(), builtin: false, members: 0, overrides: [] };
    await applyGrants(db, s, role, Object.fromEntries(Object.entries(input.grants).filter(([, v]) => v)));
    return view((await db.rows<Row>(`${SELECT} AND r.key = $2`, [s.orgId, key]))[0]);
  });
}

export async function patchRole(s: Session, key: string, input: { name?: string; grants?: Record<string, boolean> }, grantId: string | undefined): Promise<RoleView> {
  if (input.grants) checkGrants(input.grants);
  return withSessionTx(s, async (db) => {
    const role = (await db.rows<Row>(`${SELECT} AND r.key = $2 FOR UPDATE OF r`, [s.orgId, key]))[0];
    if (!role) throw new HttpError(404, 'ROLE_NOT_FOUND', 'No such role.');
    await consumeGrant(db, s, 'roles.manage', s.orgId, grantId);
    if (role.key === 'owner' && role.builtin && input.grants && OWNER_LOCKED.some((p) => input.grants![p] === false)) {
      throw new HttpError(422, 'OWNER_GRANT_LOCKED', 'The owner always keeps staff, roles and organisation settings.');
    }
    if (input.name !== undefined && input.name.trim() !== role.name) {
      if (role.builtin) throw new HttpError(422, 'BUILTIN_ROLE', 'Built-in roles cannot be renamed.');
      await db.rows('UPDATE org_roles SET name = $3 WHERE org_id = $1 AND key = $2', [s.orgId, key, input.name.trim()]);
      await writeAudit(db, { orgId: s.orgId, action: 'role.changed', actorLabel: s.name, actorRole: s.roleKey,
        staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: s.orgId, detail: { role: key, fields: ['name'] } });
    }
    if (input.grants) await applyGrants(db, s, role, input.grants);
    return view((await db.rows<Row>(`${SELECT} AND r.key = $2`, [s.orgId, key]))[0]);
  });
}

export const PERMISSION_KEYS = Object.keys(PERMISSIONS) as Permission[];
