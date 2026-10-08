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
  { kind: 'constraint', table: 'reauth_grants', name: 'reauth_grants_expiry_cap', since: 11 },
  { kind: 'constraint', table: 'reauth_grants', name: 'reauth_grants_purpose', since: 11 },
  { kind: 'security_definer', name: 'pin_pepper_census_apply', owner: 'pharmacy_migrator', since: 11 },
  { kind: 'trigger', table: 'staff_users', name: 'staff_users_pin_census', since: 11 },
  { kind: 'constraint', table: 'sign_in_throttle', name: 'sign_in_throttle_login_key', since: 12 },
  { kind: 'constraint', table: 'medicine_master', name: 'medicine_master_schedule_flags', since: 13 },
  { kind: 'trigger', table: 'stock_settings', name: 'stock_settings_history', since: 14 },
  { kind: 'trigger', table: 'stock_settings_history', name: 'stock_settings_history_append_only', since: 14 },
  { kind: 'constraint', table: 'stock_settings', name: 'stock_settings_org_key', since: 14 },
  { kind: 'trigger', table: 'premises_settings', name: 'premises_settings_history', since: 15 },
  { kind: 'trigger', table: 'premises_settings_history', name: 'premises_settings_history_append_only', since: 15 },
  { kind: 'constraint', table: 'premises_settings', name: 'premises_settings_mode', since: 15 },
  { kind: 'constraint', table: 'stock_locations', name: 'stock_locations_premises_key', since: 16 },
  { kind: 'trigger', table: 'items', name: 'items_requires_prescription', since: 17 },
  { kind: 'trigger', table: 'item_units', name: 'item_units_guard', since: 17 },
  { kind: 'constraint', table: 'items', name: 'items_track_batches', since: 17 },
  { kind: 'constraint', table: 'item_units', name: 'item_units_item_key', since: 17 },
  { kind: 'constraint', table: 'batches', name: 'batches_number_key', since: 19 },
  { kind: 'constraint', table: 'batches', name: 'batches_premises_item_key', since: 19 },
  { kind: 'constraint', table: 'batches', name: 'batches_mrp_positive', since: 19 },
  { kind: 'trigger', table: 'stock_movements', name: 'stock_movements_append_only', since: 20 },
  { kind: 'trigger', table: 'stock_movements', name: 'stock_movements_validate', since: 20 },
  { kind: 'trigger', table: 'stock_movements', name: 'stock_movements_apply', since: 20 },
  { kind: 'trigger', table: 'stock_movements', name: 'stock_movements_asof_check', since: 20 },
  { kind: 'security_definer', name: 'stock_movements_apply', owner: 'pharmacy_migrator', since: 20 },
  { kind: 'trigger', table: 'items', name: 'items_freeze', since: 20 },
  { kind: 'constraint', table: 'stock_movements', name: 'stock_movements_sign', since: 20 },
  { kind: 'constraint', table: 'stock_movements', name: 'stock_movements_reason', since: 20 },
  { kind: 'constraint', table: 'stock_movements', name: 'stock_movements_reversal_link', since: 20 },
  { kind: 'constraint', table: 'stock_movements', name: 'stock_movements_reverses_key', since: 20 },
  { kind: 'constraint', table: 'stock_movements', name: 'stock_movements_batch_fk', since: 20 },
  { kind: 'constraint', table: 'stock_balances', name: 'stock_balances_on_hand', since: 20 },
  { kind: 'constraint', table: 'stock_balances', name: 'stock_balances_key', since: 20 },
  { kind: 'constraint', table: 'idempotency_keys', name: 'idempotency_keys_key', since: 21 },
  { kind: 'trigger', table: 'goods_receipts', name: 'goods_receipts_guard', since: 22 },
  { kind: 'trigger', table: 'goods_receipt_lines', name: 'goods_receipt_lines_guard', since: 22 },
  { kind: 'constraint', table: 'goods_receipts', name: 'goods_receipts_received_after_invoice', since: 22 },
  { kind: 'constraint', table: 'goods_receipts', name: 'goods_receipts_posted', since: 22 },
  { kind: 'constraint', table: 'goods_receipt_lines', name: 'goods_receipt_lines_batch', since: 22 },
];
