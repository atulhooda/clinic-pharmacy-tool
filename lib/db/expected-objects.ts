/**
 * 06a §2.5 check 4: the enforcement objects the self-check requires. Each PR that adds a
 * guard (a trigger, a CHECK, a UNIQUE, a security-definer function) adds it here, so
 * dropping it makes every route answer 503 SCHEMA_UNVERIFIED (06b DL-18).
 */
export type ExpectedObject =
  | { kind: 'function'; name: string; since: number }
  | { kind: 'security_definer'; name: string; owner: string; since: number }
  | { kind: 'constraint'; table: string; name: string; since: number }
  | { kind: 'trigger'; table: string; name: string; since: number };

export const EXPECTED_OBJECTS: readonly ExpectedObject[] = [
  { kind: 'function', name: 'forbid_mutation', since: 1 },
  { kind: 'function', name: 'ist_date', since: 1 },
  { kind: 'security_definer', name: 'auth_resolve_org', owner: 'pharmacy_resolver', since: 1 },
  { kind: 'constraint', table: 'organisations', name: 'organisations_slug_key', since: 1 },
  { kind: 'constraint', table: 'premises', name: 'premises_org_fk', since: 1 },
  { kind: 'trigger', table: 'org_settings', name: 'org_settings_history', since: 2 },
  { kind: 'trigger', table: 'org_settings_history', name: 'org_settings_history_append_only', since: 2 },
  { kind: 'constraint', table: 'org_settings', name: 'org_settings_org_key', since: 2 },
  { kind: 'trigger', table: 'org_roles', name: 'org_roles_guard', since: 3 },
  { kind: 'constraint', table: 'role_grants', name: 'role_grants_role_permission_key', since: 3 },
  { kind: 'constraint', table: 'staff_users', name: 'staff_users_login_key', since: 5 },
  { kind: 'constraint', table: 'staff_users', name: 'staff_users_switch_pin_shape', since: 5 },
  { kind: 'constraint', table: 'staff_users', name: 'staff_users_signing_pin_shape', since: 5 },
  { kind: 'constraint', table: 'sessions', name: 'sessions_expiry_cap', since: 8 },
  { kind: 'trigger', table: 'audit_log', name: 'audit_log_append_only', since: 10 },
  { kind: 'constraint', table: 'audit_log', name: 'audit_log_detail_size', since: 10 },
];
