/**
 * The permission catalogue and the built-in roles' default grants (06a §4.1, §4.2), plus
 * which permissions are PIN-gated (§3.7, D-33). Routes check these keys, so the catalogue
 * lives in code; per-organisation overrides and custom roles are rows (role_grants).
 * test/permissions.test.ts compares this table with the spec.
 */
type Defaults = { owner: boolean; doctor: boolean; reception: boolean; pinGated: boolean };
const D = (owner: number, doctor: number, reception: number, pinGated = 0): Defaults =>
  ({ owner: !!owner, doctor: !!doctor, reception: !!reception, pinGated: !!pinGated });

export const PERMISSIONS = {
  // Administration
  'org.settings': D(1, 0, 0, 1),
  'staff.manage': D(1, 0, 0, 1),
  'roles.manage': D(1, 0, 0, 1),
  'devices.manage': D(1, 0, 0, 1),
  'audit.view': D(1, 0, 0),
  // People and prescriptions
  'patients.view': D(1, 1, 1),
  'patients.edit': D(1, 1, 1),
  'patients.merge': D(1, 0, 0, 1),
  'prescribers.manage': D(1, 0, 0),
  'rx.view': D(1, 1, 1),
  'rx.enter': D(1, 1, 1),
  'rx.verify': D(1, 1, 0, 1),
  // Stock
  'stock.view': D(1, 1, 1),
  'stock.items': D(1, 0, 0),
  'stock.receive': D(1, 0, 1),
  'stock.dispense': D(1, 1, 1),
  'stock.backdate': D(1, 1, 1, 1),
  'stock.backdate_extended': D(1, 0, 0, 1),
  'dispense.view': D(1, 1, 1),
  'stock.writeoff': D(1, 0, 0, 1),
  'stock.adjust': D(1, 0, 0, 1),
  'stock.import': D(1, 0, 0, 1),
  'stock.reports': D(1, 1, 0),
  'stock.registers': D(1, 1, 0, 1),
  'stock.settings': D(1, 0, 0, 1),
} as const satisfies Record<string, Defaults>;

export type Permission = keyof typeof PERMISSIONS;
export const BUILTIN_ROLES = ['owner', 'doctor', 'reception'] as const;
export type BuiltinRole = (typeof BUILTIN_ROLES)[number];

/** §4.1: an organisation cannot lock itself out. */
export const OWNER_LOCKED: readonly Permission[] = ['staff.manage', 'roles.manage', 'org.settings'];

export function isPermission(key: string): key is Permission {
  return Object.prototype.hasOwnProperty.call(PERMISSIONS, key);
}

/**
 * Effective permissions for a role: a built-in role starts from its code defaults and
 * applies the organisation's overrides; a custom role has only what its rows allow.
 * Unknown keys in rows are ignored (the service refuses to write them).
 */
export function effectivePermissions(
  roleKey: string,
  builtin: boolean,
  overrides: readonly { permission: string; allowed: boolean }[],
): Set<Permission> {
  const out = new Set<Permission>();
  if (builtin && (BUILTIN_ROLES as readonly string[]).includes(roleKey)) {
    for (const [key, d] of Object.entries(PERMISSIONS)) if (d[roleKey as BuiltinRole]) out.add(key as Permission);
  }
  for (const o of overrides) {
    if (!isPermission(o.permission)) continue;
    if (o.allowed) out.add(o.permission);
    else out.delete(o.permission);
  }
  if (roleKey === 'owner' && builtin) for (const k of OWNER_LOCKED) out.add(k);
  return out;
}

/** §3.7 (D-33): only roles holding a PIN-gated permission get a signing PIN. */
export function holdsPinGatedPermission(perms: ReadonlySet<string>): boolean {
  return [...perms].some((p) => isPermission(p) && PERMISSIONS[p].pinGated);
}
