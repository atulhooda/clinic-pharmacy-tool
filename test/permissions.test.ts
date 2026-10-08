// The permission catalogue in code equals the spec (06a §4.2 table and §3.7's PIN-gated list),
// and effective grants follow §4.1 (defaults in code, overrides as data, owner cannot lock out).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { PERMISSIONS, effectivePermissions, holdsPinGatedPermission, OWNER_LOCKED } from '../lib/auth/permissions';

const spec = fs.readFileSync(path.join(process.cwd(), 'docs/specs/06a-dispensary-ledger.design.md'), 'utf8');

test('06a §4.2: every permission key and its owner/doctor/reception defaults match the spec table', () => {
  const section = spec.slice(spec.indexOf('### 4.2 Permission keys and defaults'), spec.indexOf('### 4.3'));
  const rows = [...section.matchAll(/^\| `([a-z._]+)` \|[^|]*\| ?(✓?) ?\| ?(✓?) ?\| ?(✓?) ?\|$/gm)];
  const fromSpec = Object.fromEntries(rows.map((m) => [m[1], { owner: !!m[2], doctor: !!m[3], reception: !!m[4] }]));
  const fromCode = Object.fromEntries(Object.entries(PERMISSIONS).map(([k, d]) => [k, { owner: d.owner, doctor: d.doctor, reception: d.reception }]));
  assert.deepEqual(fromCode, fromSpec);
});

test('06a §3.7: the PIN-gated permissions match the spec list', () => {
  const block = spec.slice(spec.indexOf('**Who gets a signing PIN (D-33).**'), spec.indexOf('The catalogue in code marks these keys.'));
  const fromSpec = [...block.matchAll(/`([a-z._]+)`/g)].map((m) => m[1]).sort();
  const fromCode = Object.entries(PERMISSIONS).filter(([, d]) => d.pinGated).map(([k]) => k).sort();
  assert.deepEqual(fromCode, fromSpec);
});

test('§4.1: built-in roles start from their defaults; overrides add and remove; custom roles get only their rows', () => {
  const reception = effectivePermissions('reception', true, []);
  assert.ok(reception.has('stock.dispense') && !reception.has('stock.adjust'));
  const tweaked = effectivePermissions('reception', true, [{ permission: 'stock.dispense', allowed: false }, { permission: 'stock.adjust', allowed: true }]);
  assert.ok(!tweaked.has('stock.dispense') && tweaked.has('stock.adjust'));
  const store = effectivePermissions('store', false, [{ permission: 'stock.view', allowed: true }, { permission: 'not.a_permission', allowed: true }]);
  assert.deepEqual([...store], ['stock.view']);
  // A custom role named like a built-in gets no defaults unless it is the built-in row.
  assert.equal(effectivePermissions('reception', false, []).size, 0);
});

test('§4.1: the owner can never lose staff.manage, roles.manage or org.settings', () => {
  const owner = effectivePermissions('owner', true, OWNER_LOCKED.map((p) => ({ permission: p, allowed: false })));
  for (const p of OWNER_LOCKED) assert.ok(owner.has(p), p);
});

test('§3.7 (D-33): owner, doctor and reception hold a PIN-gated permission; a stock-only role does not', () => {
  for (const r of ['owner', 'doctor', 'reception']) assert.ok(holdsPinGatedPermission(effectivePermissions(r, true, [])), r);
  assert.equal(holdsPinGatedPermission(effectivePermissions('store', false, [
    { permission: 'stock.view', allowed: true }, { permission: 'stock.receive', allowed: true }, { permission: 'stock.reports', allowed: true }])), false);
});
