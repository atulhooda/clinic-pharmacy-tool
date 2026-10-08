// The database rules of migrations 002–010 (06a §3.2, §3.4, §3.12, §4.1, §6.1, §6.2), checked
// directly in SQL so they hold whatever the app code does. Each case answers with the
// Postgres error code, or the HINT for the app's own triggers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import { as } from './harness/env';
import { createOrg, createStaff, inOrg, type OrgFixture } from './harness/fixtures';

const HASH = 'scrypt$15$8$1$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const PIN = (v: string) => `scrypt$15$8$1$${v}$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB`;

/** Run SQL as the app role in the organisation's tenant; 'ok', or the hint/code it failed with. */
async function tryApp(org: OrgFixture, sql: string, params: unknown[] = []): Promise<string> {
  return inOrg(org.orgId, (c) => c.query(sql, params)).then(() => 'ok', (e) => e.hint ?? e.code);
}
/** The same as the migrator (the table owner), to reach triggers the app's grants stop first. */
async function tryOwner(org: OrgFixture, sql: string, params: unknown[] = []): Promise<string> {
  return as('migrator', async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
    const r = await c.query(sql, params).then(() => 'ok', (e) => e.hint ?? e.code);
    await c.query('ROLLBACK');
    return r;
  });
}

test('003 / §4.1: built-in roles cannot be renamed, un-built-in or deleted; no role key ever changes', async () => {
  const org = await createOrg('sch-roles');
  assert.equal(await tryApp(org, "UPDATE org_roles SET name = 'Front desk' WHERE key = 'reception'"), 'BUILTIN_ROLE');
  assert.equal(await tryApp(org, "UPDATE org_roles SET builtin = false WHERE key = 'doctor'"), 'BUILTIN_ROLE');
  assert.equal(await tryApp(org, "UPDATE org_roles SET key = 'boss' WHERE key = 'owner'"), 'ROLE_KEY_IMMUTABLE');
  assert.equal(await tryApp(org, "INSERT INTO org_roles (org_id, key, name) VALUES ($1, 'store', 'Store')", [org.orgId]), 'ok');
  assert.equal(await tryApp(org, "UPDATE org_roles SET name = 'Stock room' WHERE key = 'store'"), 'ok', 'custom roles can be renamed');
  assert.equal(await tryApp(org, "UPDATE org_roles SET key = 'stock' WHERE key = 'store'"), 'ROLE_KEY_IMMUTABLE');
  assert.equal(await tryApp(org, "DELETE FROM org_roles WHERE key = 'store'"), '42501', 'the app never deletes roles');
  assert.equal(await tryOwner(org, "DELETE FROM org_roles WHERE key = 'owner'"), 'BUILTIN_ROLE');
  assert.equal(await tryApp(org, "INSERT INTO org_roles (org_id, key, name, builtin) VALUES ($1, 'clerk', 'Clerk', true)", [org.orgId]), '23514');
  assert.equal(await tryApp(org, "INSERT INTO org_roles (org_id, key, name) VALUES ($1, 'Bad Key', 'x')", [org.orgId]), '23514');
  assert.equal(await tryApp(org, "INSERT INTO role_grants (org_id, role_key, permission, allowed) VALUES ($1, 'store', 'Stock View', true)", [org.orgId]), '23514');
});

test('002 / §6.1: settings ranges; the settings history is append-only', async () => {
  const org = await createOrg('sch-settings');
  for (const [col, v, want] of [['device_lock_minutes', 0, '23514'], ['device_lock_minutes', 11, '23514'], ['device_lock_minutes', 10, 'ok'],
    ['untrusted_idle_minutes', 4, '23514'], ['untrusted_idle_minutes', 721, '23514'], ['untrusted_idle_minutes', 5, 'ok']] as const) {
    assert.equal(await tryApp(org, `UPDATE org_settings SET ${col} = $1`, [v]), want, `${col} = ${v}`);
  }
  assert.equal(await tryApp(org, 'UPDATE org_settings_history SET version = 9'), '42501');
  assert.equal(await tryApp(org, 'DELETE FROM org_settings_history'), '42501');
  assert.equal(await tryOwner(org, 'UPDATE org_settings_history SET version = 9'), 'LEDGER_APPEND_ONLY');
  assert.equal(await tryOwner(org, 'DELETE FROM org_settings_history'), 'LEDGER_APPEND_ONLY');
});

test('004 / §6.2: an external prescriber needs an address; phone numbers are E.164', async () => {
  const org = await createOrg('sch-rx');
  const ins = (kind: string, address: string | null, phone: string | null) => tryApp(org,
    "INSERT INTO prescribers (org_id, kind, name, address, phone_e164) VALUES ($1, $2, 'Dr. Synthetic', $3, $4)", [org.orgId, kind, address, phone]);
  assert.equal(await ins('EXTERNAL', null, null), '23514');
  assert.equal(await ins('EXTERNAL', '2 Clinic Road', null), 'ok');
  assert.equal(await ins('INTERNAL', null, null), 'ok');
  assert.equal(await ins('INTERNAL', null, '98000 00001'), '23514');
  assert.equal(await ins('VISITING', null, null), '23514');
});

test('005 / §3.2, §3.12: logins, hash shapes and the credential rule', async () => {
  const org = await createOrg('sch-staff');
  const ins = (o: { login?: string; hash?: string | null; phone?: string | null; switchPin?: string; signingPin?: string }) => tryApp(org,
    `INSERT INTO staff_users (org_id, name, login, role_key, password_hash, phone_e164, switch_pin_hash, signing_pin_hash)
     VALUES ($1, $2, $3, 'reception', $4, $5, $6, $7)`,
    [org.orgId, `S ${randomUUID().slice(0, 8)}`, o.login ?? `l${randomUUID().slice(0, 8)}`, o.hash === undefined ? HASH : o.hash,
      o.phone ?? null, o.switchPin ?? null, o.signingPin ?? null]);
  assert.equal(await ins({}), 'ok');
  assert.equal(await ins({ login: 'Has Space' }), '23514');
  assert.equal(await ins({ login: 'ab' }), '23514');
  assert.equal(await ins({ hash: 'plain-text-password' }), '23514', 'a password is never stored in clear');
  assert.equal(await ins({ hash: 'scrypt$14$8$1$AAAAAAAAAAAAAAAAAAAAAA$BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }), '23514', 'weaker parameters');
  assert.equal(await ins({ hash: null }), '23514', 'no password and no phone');
  assert.equal(await ins({ hash: null, phone: '+919800000071' }), 'ok', 'phone-only (OTP, Milestone 2)');
  assert.equal(await ins({ switchPin: PIN('p1') }), 'ok');
  assert.equal(await ins({ switchPin: HASH }), '23514', 'a PIN hash must carry its pepper version');
  assert.equal(await ins({ signingPin: PIN('p') }), '23514');
  assert.equal(await tryApp(org, 'UPDATE staff_users SET password_failures = -1'), '23514');
  assert.equal(await tryApp(org, 'DELETE FROM staff_users'), '42501', 'people are deactivated, never deleted');
});

test('007 / §3.5: a revoked device frees its name; revocation records who', async () => {
  const org = await createOrg('sch-dev');
  const owner = await createStaff(org, { role: 'owner' });
  const ins = (name: string, revoked: boolean, by: string | null) => tryApp(org,
    `INSERT INTO devices (org_id, premises_id, name, registered_by, revoked_at, revoked_by) VALUES ($1, $2, $3, $4, $5, $6)`,
    [org.orgId, org.premisesId, name, owner.id, revoked ? new Date() : null, by]);
  assert.equal(await ins('Front Desk', true, owner.id), 'ok');
  assert.equal(await ins('front desk', false, null), 'ok', 'the old name is free once revoked');
  assert.equal(await ins('Front desk', false, null), '23505');
  assert.equal(await ins('Back Office', true, null), '23514', 'revoked_at without revoked_by');
  assert.equal(await tryApp(org, 'DELETE FROM devices'), '42501');
});

test('008 / §3.4: sessions never outlive 16 hours; revocation needs a known reason; at most 5 secret failures', async () => {
  const org = await createOrg('sch-sess');
  const s = await createStaff(org);
  const ins = (hours: number, extra = '', vals: unknown[] = []) => tryApp(org,
    `INSERT INTO sessions (org_id, staff_user_id, method, created_at, expires_at, last_input_at${extra ? `, ${extra}` : ''})
     VALUES ($1, $2, 'PASSWORD', now(), now() + make_interval(hours => $3), now()${vals.map((_, i) => `, $${i + 4}`).join('')})`,
    [org.orgId, s.id, hours, ...vals]);
  assert.equal(await ins(16), 'ok');
  assert.equal(await ins(17), '23514');
  assert.equal(await ins(0), '23514', 'expires after it starts');
  assert.equal(await ins(1, 'revoked_at', [new Date()]), '23514', 'a revocation needs a reason');
  assert.equal(await ins(1, 'revoked_reason', ['expired']), '23514', 'a reason needs a time');
  assert.equal(await ins(1, 'revoked_at, revoked_reason', [new Date(), 'because']), '23514');
  assert.equal(await ins(1, 'secret_failures', [6]), '23514');
  assert.equal(await tryApp(org, 'DELETE FROM sessions'), '42501', 'sessions are revoked, never deleted');
});

test('010 / §3.11: audit detail is a small JSON object; actions are dotted lower-case; ops cannot rewrite it', async () => {
  const org = await createOrg('sch-audit');
  const ins = (action: string, detail: string) => tryApp(org,
    "INSERT INTO audit_log (org_id, actor_label, actor_role, action, detail) VALUES ($1, 'x', 'system', $2, $3::jsonb)", [org.orgId, action, detail]);
  assert.equal(await ins('auth.sign_out', '{}'), 'ok');
  assert.equal(await ins('auth.sign_out', '[]'), '23514');
  assert.equal(await ins('auth.sign_out', JSON.stringify({ reason: 'x'.repeat(2100) })), '23514');
  assert.equal(await ins('SignOut', '{}'), '23514');
  assert.equal(await ins('auth', '{}'), '23514');
  const ops = await as('ops', async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [org.orgId]);
    const r = await c.query("UPDATE audit_log SET action = 'x.y'").then(() => 'ok', (e) => e.code);
    await c.query('ROLLBACK');
    return r;
  });
  assert.equal(ops, '42501');
});
