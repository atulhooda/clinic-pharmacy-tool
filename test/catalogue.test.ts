// PR 5, catalogue and settings (E-01 … E-09, E-12 … E-17, E-20, E-21): 06b DG-01 … 03, 05 … 07,
// 09 … 11 (DG-08's dispense half and DG-09's dispense half come with PR 9); DX-33 … 37, 39 … 42,
// 45 (DX-43, E-18 movements, comes with the ledger in PR 7); DH-13; DPN-08 (premises.legal_settings).
// Seed rows are picked by their flags, never by a drug name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createOrg, createStaff, inOrg, type OrgFixture, type StaffFixture } from './harness/fixtures';
import { as, pgCode, urls } from './harness/env';
import { Browser } from './harness/http';
import { ROUTES } from '../lib/routes';
import { POST as reauthRoute } from '../app/api/auth/reauth/route';
import { GET as settingsGet, PUT as settingsPut } from '../app/api/dispensary/settings/route';
import { POST as setupPost } from '../app/api/dispensary/setup/route';
import { GET as dPremisesGet } from '../app/api/dispensary/premises/route';
import { POST as premisesSetup } from '../app/api/dispensary/premises/[id]/setup/route';
import { PUT as premisesSettingsPut } from '../app/api/dispensary/premises/[id]/settings/route';
import { PATCH as locationPatch } from '../app/api/dispensary/locations/[id]/route';
import { GET as masterGet } from '../app/api/dispensary/master/route';
import { GET as masterOne } from '../app/api/dispensary/master/[id]/route';
import { GET as itemsGet, POST as itemsPost } from '../app/api/dispensary/items/route';
import { GET as itemGet, PATCH as itemPatch } from '../app/api/dispensary/items/[id]/route';
import { POST as unitPost } from '../app/api/dispensary/items/[id]/units/route';
import { PATCH as unitPatch } from '../app/api/dispensary/items/[id]/units/[unitId]/route';
import { GET as suppliersGet, POST as suppliersPost } from '../app/api/dispensary/suppliers/route';
import { GET as supplierGet, PATCH as supplierPatch } from '../app/api/dispensary/suppliers/[id]/route';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const loader = require('../scripts/load-master.cjs') as { readSources: (d?: string) => { source: string; file: string; licence: string }[]; readSeed: (d?: string) => Seed[]; load: (u: string, d?: string) => Promise<unknown> };

type Seed = { source: string; source_ref: string; brand_name: string; dosage_form: string; salts: { name: string }[]; requires_prescription: boolean };
const NONEXIST = '00000000-0000-4000-8000-000000000000';
const SEED_DIR = path.join(process.cwd(), 'data/master');
const ORAL = ['TABLET', 'CAPSULE', 'SYRUP', 'SUSPENSION', 'SOLUTION', 'DROPS', 'SACHET', 'POWDER'];
const d32Salts = () => {
  const md = fs.readFileSync(path.join(SEED_DIR, 'SOURCES.md'), 'utf8');
  return md.slice(md.indexOf('<!-- d32-salts -->'), md.indexOf('<!-- /d32-salts -->')).split('\n')
    .filter((l) => l.startsWith('- ')).map((l) => l.slice(2).trim().toLowerCase());
};
async function masterIdWhere(where: string): Promise<string> {
  return as('app', async (c) => (await c.query(`SELECT id FROM medicine_master WHERE ${where} ORDER BY source_ref LIMIT 1`)).rows[0].id);
}

interface World { org: OrgFixture; aa: StaffFixture; af: StaffFixture; owner: Browser; second: string }
async function world(label: string, opts: { setup?: boolean } = {}): Promise<World> {
  const org = await createOrg(label);
  const second = await inOrg(org.orgId, async (c) => (await c.query(
    "INSERT INTO premises (org_id, name, address, state_code) VALUES ($1, 'Second', '2 Test Road, Maharashtra', '27') RETURNING id", [org.orgId])).rows[0].id);
  const [aa, af] = await Promise.all([createStaff(org, { role: 'owner', name: `Owner ${label}` }), createStaff(org, { role: 'reception', name: `Af ${label}` })]);
  const owner = new Browser();
  await owner.signIn(org.slug, aa.login, aa.password);
  const w = { org, aa, af, owner, second };
  if (opts.setup !== false) {
    assert.equal((await owner.call(setupPost, { body: {} })).status, 201);
    const r = await owner.call(premisesSetup, { body: PREMISES, params: { id: org.premisesId }, headers: { 'reauth-grant': await grant(w, 'premises.legal_settings', org.premisesId) } });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  return w;
}
const PREMISES = { dispensingMode: 'RMP_OWN_PATIENTS', ndpsLicenceNo: null, ndpsLicenceValidTill: null, scheduleXLicenceNo: null,
  scheduleXLicenceValidTill: null, h1RegisterExtraFields: ['PATIENT_ADDRESS'], prescriptionMaxAgeDays: null };
async function grant(w: World, purpose: string, entityId: string): Promise<string> {
  const r = await w.owner.call(reauthRoute, { body: { pin: w.aa.signingPin, purpose, entityId } });
  assert.equal(r.status, 201);
  return r.body.grantId;
}
const custom = (name: string, extra: Record<string, unknown> = {}) => ({ category: 'MEDICINE', displayName: name, baseUnit: 'TABLET', ...extra });

test('DG-01 / DX-37 / DG-03: the master is the same for every organisation and role, and the app cannot write it', async () => {
  const A = await world('dg1a', { setup: false });
  const B = await world('dg1b', { setup: false });
  const af = new Browser();
  await af.signIn(A.org.slug, A.af.login, A.af.password);
  const lists = await Promise.all([A.owner, af, B.owner].map(async (b) => (await b.call(masterGet, { path: '/api/dispensary/master?limit=200' })).body.items));
  assert.ok(lists[0].length >= 15);
  assert.deepEqual(lists[1], lists[0]);
  assert.deepEqual(lists[2], lists[0], 'the same global rows');
  const one = await B.owner.call(masterOne, { params: { id: lists[0][0].id } });
  assert.deepEqual(one.body, lists[0][0]);
  assert.equal((await A.owner.call(masterOne, { params: { id: NONEXIST } })).body.code, 'MASTER_NOT_FOUND');
  for (const sql of ["INSERT INTO medicine_master (brand_name, manufacturer_name, dosage_form, source, source_ref) VALUES ('x', 'y', 'TABLET', 's', 'r')",
    "UPDATE medicine_master SET brand_name = 'x'", 'DELETE FROM medicine_master']) {
    assert.equal(await as('app', (c) => pgCode(c.query(sql))), '42501', sql);
  }
});

test('DG-01 (search): by text and by salt', async () => {
  const A = await world('dgs', { setup: false });
  const rx = await as('app', async (c) => (await c.query("SELECT brand_name AS b, salts->0->>'name' AS s FROM medicine_master WHERE requires_prescription ORDER BY source_ref LIMIT 1")).rows[0]);
  const byText = (await A.owner.call(masterGet, { path: `/api/dispensary/master?q=${encodeURIComponent(rx.b.slice(0, 6))}` })).body.items;
  assert.ok(byText.some((m: { brandName: string }) => m.brandName === rx.b));
  const bySalt = (await A.owner.call(masterGet, { path: `/api/dispensary/master?salt=${encodeURIComponent(rx.s.toUpperCase())}` })).body.items;
  assert.ok(bySalt.length >= 2 && bySalt.every((m: { salts: { name: string }[] }) => m.salts.some((x) => x.name.toLowerCase() === rx.s.toLowerCase())));
});

test('DG-02: no route writes the master', () => {
  const writes = ROUTES.filter((r) => r.path.startsWith('/api/dispensary/master') && r.methods.some((m) => m !== 'GET'));
  assert.deepEqual(writes.map((r) => r.path), [], 'only corrections may write, and they are Milestone 2');
});

test('DG-05 / DG-06: effective flags are master ∪ extra; a curator change shows at once; no request can remove a master flag', async () => {
  const A = await world('dg5');
  const masterId = await masterIdWhere("NOT requires_prescription AND schedule_flags = '{}' AND source = 'inn-generic-draft'");
  const created = await A.owner.call(itemsPost, { body: { masterId, category: 'MEDICINE', displayName: 'Linked item', baseUnit: 'TABLET' } });
  assert.deepEqual([created.status, created.body.scheduleFlags], [201, []]);
  const id = created.body.id;
  const extra = await A.owner.call(itemPatch, { method: 'PATCH', body: { extraScheduleFlags: ['H1'] }, params: { id } });
  assert.deepEqual(extra.body.scheduleFlags, ['H1'], 'DG-06');
  await as('curator', (c) => c.query("UPDATE medicine_master SET schedule_flags = '{H}', version = version + 1 WHERE id = $1", [masterId]));
  try {
    assert.deepEqual((await A.owner.call(itemGet, { params: { id } })).body.scheduleFlags, ['H', 'H1'], 'DG-05: at once, no deploy');
    const cleared = await A.owner.call(itemPatch, { method: 'PATCH', body: { extraScheduleFlags: [] }, params: { id } });
    assert.deepEqual(cleared.body.scheduleFlags, ['H'], 'the master flag stays');
    assert.equal((await A.owner.call(itemPatch, { method: 'PATCH', body: { scheduleFlags: [] }, params: { id } })).body.code, 'UNKNOWN_FIELD');
  } finally {
    await as('curator', (c) => c.query("UPDATE medicine_master SET schedule_flags = '{}', version = version + 1 WHERE id = $1", [masterId]));
  }
});

test('DG-07: the loader reads only files listed in SOURCES.md, each with a licence note', async () => {
  const sources = loader.readSources();
  assert.ok(sources.length >= 2 && sources.every((s) => s.licence.length > 10), 'every source has a licence note');
  const files = fs.readdirSync(SEED_DIR).filter((f) => f.endsWith('.json'));
  assert.deepEqual(files.sort(), sources.map((s) => s.file).sort(), 'no seed file is outside SOURCES.md');
  const rows = loader.readSeed();
  assert.ok(rows.every((r) => sources.some((s) => s.source === r.source)));
  // A file that is not listed is never read; a source without a licence is refused.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-'));
  for (const f of fs.readdirSync(SEED_DIR)) fs.copyFileSync(path.join(SEED_DIR, f), path.join(dir, f));
  fs.writeFileSync(path.join(dir, 'unlisted.json'), JSON.stringify([{ source_ref: 'u-1', brand_name: 'Unlisted', manufacturer_name: 'x', dosage_form: 'TABLET', salts: [] }]));
  assert.equal(loader.readSeed(dir).length, rows.length);
  fs.writeFileSync(path.join(dir, 'SOURCES.md'), fs.readFileSync(path.join(dir, 'SOURCES.md'), 'utf8')
    .replace(/(\| `inn-generic-draft` \| `inn-generic-draft.json` \|)[^|]*\|/, '$1  |'));
  assert.throws(() => loader.readSeed(dir), /no licence note/);
  // Loading twice changes nothing (upsert by source and reference).
  assert.deepEqual(await loader.load(urls.curator), { rows: rows.length, inserted: 0, updated: 0 });
});

test('DG-11: requires_prescription is true on every oral form of the D-32 salts, false on their topical forms, and nowhere else', async () => {
  const salts = d32Salts();
  assert.ok(salts.length >= 2);
  const rows = loader.readSeed();
  const ofSalt = rows.filter((r) => r.salts.some((s) => salts.includes(s.name.toLowerCase())));
  assert.ok(ofSalt.some((r) => ORAL.includes(r.dosage_form)) && ofSalt.some((r) => !ORAL.includes(r.dosage_form)), 'oral and topical forms are both present');
  for (const r of rows) {
    const expected = ofSalt.includes(r) && ORAL.includes(r.dosage_form);
    assert.equal(r.requires_prescription, expected, `${r.source}/${r.source_ref}`);
  }
  const db = await as('app', async (c) => (await c.query('SELECT source, source_ref AS ref, requires_prescription AS rx FROM medicine_master')).rows);
  for (const r of rows) assert.equal(db.find((x) => x.source === r.source && x.ref === r.source_ref)?.rx, r.requires_prescription);
});

test('DH-13: no drug or salt name from the seed appears in the code', () => {
  const names = new Set<string>();
  for (const r of loader.readSeed()) for (const s of r.salts) if (s.name.length > 4) names.add(s.name.toLowerCase());
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(ts|tsx|cjs|mjs|js|sql)$/.test(e.name)) {
        const src = fs.readFileSync(p, 'utf8').toLowerCase();
        for (const n of names) if (new RegExp(`\\b${n}\\b`).test(src)) hits.push(`${p}: ${n}`);
      }
    }
  };
  for (const d of ['app', 'lib', 'components', 'scripts', 'migrations']) walk(path.join(process.cwd(), d));
  assert.deepEqual(hits, []);
});

test('DG-09 / DG-10: requires_prescription is set from the master, imposed by it or by Schedule X, and changes are audited', async () => {
  const A = await world('dg9');
  const rxMaster = await masterIdWhere("requires_prescription AND dosage_form IN ('TABLET','CAPSULE')");
  const linked = await A.owner.call(itemsPost, { body: { masterId: rxMaster, category: 'MEDICINE', displayName: 'Linked rx item', baseUnit: 'CAPSULE' } });
  assert.deepEqual([linked.status, linked.body.requiresPrescription, linked.body.requiresPrescriptionImposed], [201, true, true], 'DG-10: set from the master');
  const refused = await A.owner.call(itemPatch, { method: 'PATCH', body: { requiresPrescription: false }, params: { id: linked.body.id } });
  assert.deepEqual([refused.status, refused.body.code], [422, 'REQUIRES_PRESCRIPTION_IMPOSED']);
  const plain = await A.owner.call(itemsPost, { body: custom('Plain tablets') });
  assert.equal(plain.body.requiresPrescription, false);
  assert.equal((await A.owner.call(itemPatch, { method: 'PATCH', body: { requiresPrescription: true }, params: { id: plain.body.id } })).body.requiresPrescription, true);
  const cleared = await A.owner.call(itemPatch, { method: 'PATCH', body: { requiresPrescription: false }, params: { id: plain.body.id } });
  assert.deepEqual([cleared.status, cleared.body.requiresPrescription], [200, false]);
  const audit = await inOrg(A.org.orgId, async (c) => (await c.query("SELECT detail FROM audit_log WHERE action = 'item.requires_prescription_changed' ORDER BY at")).rows.map((r) => r.detail));
  assert.deepEqual(audit, [{ from: false, to: true }, { from: true, to: false }]);
  // Schedule X imposes it too, through the API and directly in SQL (the trigger is the guarantee).
  const x = await A.owner.call(itemsPost, { body: custom('X item', { extraScheduleFlags: ['X'] }) });
  assert.equal(x.body.requiresPrescription, true);
  const sql = await inOrg(A.org.orgId, (c) => c.query('UPDATE items SET requires_prescription = false WHERE id = $1', [x.body.id])).then(() => 'ok', (e) => e.hint);
  assert.equal(sql, 'REQUIRES_PRESCRIPTION_IMPOSED');
});

test('E-02 / E-03 / DX-33: dispensary settings: one setup, If-Match edits, ranges; another organisation\'s row is untouched', async () => {
  const A = await world('dx33a', { setup: false });
  const B = await world('dx33b');
  assert.equal((await A.owner.call(settingsGet)).body.code, 'DISPENSARY_NOT_CONFIGURED');
  const made = await A.owner.call(setupPost, { body: { dispenseReversalWindowHours: 12 } });
  assert.deepEqual([made.status, made.body.dispenseReversalWindowHours, made.body.nearExpiryWindowsDays], [201, 12, [30, 60, 90]]);
  assert.equal((await A.owner.call(setupPost, { body: {} })).body.code, 'ALREADY_CONFIGURED');
  const full = { ...made.body };
  delete full.version;
  const bad = await A.owner.call(settingsPut, { method: 'PUT', body: { ...full, scheduledEntryMaxMinutes: 130 }, headers: { 'if-match': '"1"' } });
  assert.deepEqual([bad.status, bad.body.code], [422, 'FIELD_INVALID']);
  const tooLong = await A.owner.call(settingsPut, { method: 'PUT', body: { ...full, backdateReasonAfterMinutes: 20, scheduledEntryMaxMinutes: 30 }, headers: { 'if-match': '"1"' } });
  assert.deepEqual([tooLong.status, tooLong.body.details?.rule], [422, 'stock_settings_scheduled_lag'], 'the scheduled lag never exceeds the reason-free lag');
  const ok = await A.owner.call(settingsPut, { method: 'PUT', body: { ...full, nearExpiryWindowsDays: [15, 45] }, headers: { 'if-match': '"1"' } });
  assert.deepEqual([ok.status, ok.body.version, ok.body.nearExpiryWindowsDays], [200, 2, [15, 45]]);
  assert.equal((await A.owner.call(settingsPut, { method: 'PUT', body: full, headers: { 'if-match': '"1"' } })).status, 412);
  const hist = await inOrg(A.org.orgId, async (c) => Number((await c.query('SELECT count(*) AS n FROM stock_settings_history')).rows[0].n));
  assert.equal(hist, 2);
  const b = await B.owner.call(settingsGet);
  assert.deepEqual([b.body.version, b.body.dispenseReversalWindowHours], [1, 24]);
});

test('E-05 / E-06: a premises chooses its mode explicitly; Milestone 1 runs RMP_OWN_PATIENTS only; setup creates store and quarantine; signed and audited', async () => {
  const A = await world('e05', { setup: false });
  const id = A.org.premisesId;
  const noStock = await A.owner.call(premisesSetup, { body: PREMISES, params: { id }, headers: { 'reauth-grant': await grant(A, 'premises.legal_settings', id) } });
  assert.equal(noStock.body.code, 'DISPENSARY_NOT_CONFIGURED');
  await A.owner.call(setupPost, { body: {} });
  const { dispensingMode, ...noMode } = PREMISES;
  void dispensingMode;
  assert.deepEqual((await A.owner.call(premisesSetup, { body: noMode, params: { id } })).body.details, { field: 'dispensingMode' }, 'no default mode');
  const other = await A.owner.call(premisesSetup, { body: { ...PREMISES, dispensingMode: 'LICENSED_PHARMACY' }, params: { id } });
  assert.deepEqual([other.status, other.body.code], [422, 'MODE_NOT_AVAILABLE']);
  assert.equal((await A.owner.call(premisesSetup, { body: PREMISES, params: { id } })).body.code, 'reauth_required');
  const r = await A.owner.call(premisesSetup, { body: PREMISES, params: { id }, headers: { 'reauth-grant': await grant(A, 'premises.legal_settings', id) } });
  assert.deepEqual([r.status, r.body.dispensingMode, r.body.version], [201, 'RMP_OWN_PATIENTS', 1]);
  const list = (await A.owner.call(dPremisesGet)).body.items;
  const main = list.find((p: { id: string }) => p.id === id);
  assert.deepEqual(main.locations.map((l: { kind: string; isDefault: boolean }) => [l.kind, l.isDefault]), [['STORE', true], ['QUARANTINE', false]]);
  assert.equal(list.find((p: { id: string }) => p.id === A.second).settings, null);
  const again = await A.owner.call(premisesSetup, { body: PREMISES, params: { id }, headers: { 'reauth-grant': await grant(A, 'premises.legal_settings', id) } });
  assert.equal(again.body.code, 'PREMISES_ALREADY_CONFIGURED');
  const put = await A.owner.call(premisesSettingsPut, { method: 'PUT', body: { ...PREMISES, prescriptionMaxAgeDays: 30 }, params: { id },
    headers: { 'if-match': '"1"', 'reauth-grant': await grant(A, 'premises.legal_settings', id) } });
  assert.deepEqual([put.status, put.body.prescriptionMaxAgeDays, put.body.version], [200, 30, 2]);
  const facts = await inOrg(A.org.orgId, async (c) => ({
    history: (await c.query('SELECT version, snapshot FROM premises_settings_history WHERE premises_id = $1 ORDER BY version', [id])).rows,
    audit: Number((await c.query("SELECT count(*) AS n FROM audit_log WHERE action = 'premises.legal_settings_changed'")).rows[0].n),
  }));
  assert.deepEqual(facts.history.map((h) => [h.version, h.snapshot.prescription_max_age_days]), [[1, null], [2, 30]]);
  assert.equal(facts.audit, 2);
});

test('DX-34 / DX-35 / DI-14 (setup): premises outside the caller\'s scope or organisation are 404; B\'s settings stay', async () => {
  const A = await world('dx35a');
  const B = await world('dx35b');
  assert.deepEqual((await A.owner.call(dPremisesGet)).body.items.map((p: { id: string }) => p.id).sort(), [A.org.premisesId, A.second].sort());
  const g = await grant(A, 'premises.legal_settings', B.org.premisesId);
  const setup = await A.owner.call(premisesSetup, { body: PREMISES, params: { id: B.org.premisesId }, headers: { 'reauth-grant': g } });
  const put = await A.owner.call(premisesSettingsPut, { method: 'PUT', body: PREMISES, params: { id: B.org.premisesId }, headers: { 'if-match': '"1"', 'reauth-grant': g } });
  for (const r of [setup, put]) assert.deepEqual([r.status, r.body.code], [404, 'PREMISES_NOT_FOUND']);
  const v = await inOrg(B.org.orgId, async (c) => (await c.query('SELECT version FROM premises_settings')).rows[0].version);
  assert.equal(v, 1);
  // A store manager limited to the main premises cannot set up the second one.
  await inOrg(A.org.orgId, async (c) => {
    await c.query("INSERT INTO org_roles (org_id, key, name) VALUES ($1, 'stockman', 'Stock manager')", [A.org.orgId]);
    await c.query("INSERT INTO role_grants (org_id, role_key, permission, allowed) VALUES ($1, 'stockman', 'stock.settings', true), ($1, 'stockman', 'stock.view', true)", [A.org.orgId]);
  });
  const sm = await createStaff(A.org, { role: 'stockman' });
  const smb = new Browser();
  await smb.signIn(A.org.slug, sm.login, sm.password);
  const g2 = (await smb.call(reauthRoute, { body: { pin: sm.signingPin, purpose: 'premises.legal_settings', entityId: A.second } })).body.grantId;
  const scoped = await smb.call(premisesSetup, { body: PREMISES, params: { id: A.second }, headers: { 'reauth-grant': g2 } });
  assert.deepEqual([scoped.status, scoped.body.code], [404, 'PREMISES_NOT_FOUND']);
});

test('E-07 / DX-36: locations are renamed within scope; default and quarantine stay active; another organisation\'s is 404', async () => {
  const A = await world('dx36a');
  const B = await world('dx36b');
  const locs = (await A.owner.call(dPremisesGet)).body.items.find((p: { id: string }) => p.id === A.org.premisesId).locations;
  const store = locs.find((l: { kind: string }) => l.kind === 'STORE');
  const q = locs.find((l: { kind: string }) => l.kind === 'QUARANTINE');
  assert.equal((await A.owner.call(locationPatch, { method: 'PATCH', body: { name: 'Front shelf' }, params: { id: store.id } })).body.name, 'Front shelf');
  assert.equal((await A.owner.call(locationPatch, { method: 'PATCH', body: { name: 'front SHELF' }, params: { id: q.id } })).body.code, 'LOCATION_NAME_TAKEN');
  assert.equal((await A.owner.call(locationPatch, { method: 'PATCH', body: { active: false }, params: { id: q.id } })).body.code, 'LOCATION_REQUIRED');
  const bLoc = (await B.owner.call(dPremisesGet)).body.items[0].locations[0].id;
  const cross = await A.owner.call(locationPatch, { method: 'PATCH', body: { name: 'Taken' }, params: { id: bLoc } });
  assert.deepEqual([cross.status, cross.body.code], [404, 'LOCATION_NOT_FOUND']);
});

test('E-07 (scope): a location at a premises outside the caller\'s membership is 404', async () => {
  const A = await world('e07s');
  const g = await grant(A, 'premises.legal_settings', A.second);
  assert.equal((await A.owner.call(premisesSetup, { body: PREMISES, params: { id: A.second }, headers: { 'reauth-grant': g } })).status, 201);
  const secondStore = (await A.owner.call(dPremisesGet)).body.items.find((p: { id: string }) => p.id === A.second).locations[0].id;
  await inOrg(A.org.orgId, async (c) => {
    await c.query("INSERT INTO org_roles (org_id, key, name) VALUES ($1, 'stockman', 'Stock manager')", [A.org.orgId]);
    await c.query("INSERT INTO role_grants (org_id, role_key, permission, allowed) VALUES ($1, 'stockman', 'stock.settings', true), ($1, 'stockman', 'stock.view', true)", [A.org.orgId]);
  });
  const sm = await createStaff(A.org, { role: 'stockman' });
  const smb = new Browser();
  await smb.signIn(A.org.slug, sm.login, sm.password);
  const r = await smb.call(locationPatch, { method: 'PATCH', body: { name: 'Not mine' }, params: { id: secondStore } });
  assert.deepEqual([r.status, r.body.code], [404, 'LOCATION_NOT_FOUND']);
});

test('E-13 / E-14 / DX-39 / DX-40: items are created with their base unit, are per organisation, and another\'s is 404', async () => {
  const A = await world('dx39a');
  const B = await world('dx39b');
  const b = await B.owner.call(itemsPost, { body: custom('B only item') });
  const a = await A.owner.call(itemsPost, { body: custom('A tablets', { reorderLevel: 20 }) });
  assert.deepEqual([a.status, a.body.trackBatches, a.body.units.map((u: { name: string; isBase: boolean; baseUnitsPerUnit: number }) => [u.name, u.isBase, u.baseUnitsPerUnit])],
    [201, true, [['tablet', true, 1]]]);
  const orgOf = await inOrg(A.org.orgId, async (c) => (await c.query('SELECT org_id FROM items WHERE id = $1', [a.body.id])).rows[0].org_id);
  assert.equal(orgOf, A.org.orgId);
  const aIds = (await A.owner.call(itemsGet)).body.items.map((i: { id: string }) => i.id);
  assert.ok(aIds.includes(a.body.id) && !aIds.includes(b.body.id));
  assert.ok(!(await B.owner.call(itemsGet)).body.items.some((i: { id: string }) => i.id === a.body.id));
  assert.equal((await A.owner.call(itemGet, { params: { id: b.body.id } })).body.code, 'ITEM_NOT_FOUND');
  assert.equal((await A.owner.call(itemsPost, { body: custom('a TABLETS') })).body.code, 'ITEM_NAME_TAKEN');
  const consumable = await A.owner.call(itemsPost, { body: { category: 'CONSUMABLE', displayName: 'Gloves', baseUnit: 'PIECE', trackBatches: false } });
  assert.deepEqual([consumable.status, consumable.body.trackBatches], [201, false]);
  const untracked = await A.owner.call(itemsPost, { body: custom('Untracked medicine', { trackBatches: false }) });
  assert.deepEqual([untracked.status, untracked.body.details?.rule], [422, 'items_track_batches'], 'only consumables may skip batches');
  const masterId = await masterIdWhere("NOT requires_prescription AND source = 'inn-generic-draft'");
  assert.equal((await A.owner.call(itemsPost, { body: { masterId, category: 'MEDICINE', displayName: 'First link', baseUnit: 'TABLET' } })).status, 201);
  assert.equal((await A.owner.call(itemsPost, { body: { masterId, category: 'MEDICINE', displayName: 'Second link', baseUnit: 'TABLET' } })).body.code, 'ITEM_ALREADY_LINKED');
  const page1 = await A.owner.call(itemsGet, { path: '/api/dispensary/items?limit=2' });
  const page2 = await A.owner.call(itemsGet, { path: `/api/dispensary/items?limit=2&cursor=${page1.body.nextCursor}` });
  const paged = [...page1.body.items, ...page2.body.items].map((i: { id: string }) => i.id);
  assert.deepEqual([paged.length, new Set(paged).size], [3, 3], 'three items, each on exactly one page');
  assert.equal(page2.body.nextCursor, null);
});

test('E-15 / DX-41: editing changes everything but identity; another organisation\'s item is 404 and unchanged', async () => {
  const A = await world('dx41a');
  const B = await world('dx41b');
  const a = await A.owner.call(itemsPost, { body: custom('Editable') });
  const r = await A.owner.call(itemPatch, { method: 'PATCH', body: { displayName: 'Edited', rackLocation: 'R2', reorderLevel: 5 }, params: { id: a.body.id } });
  assert.deepEqual([r.status, r.body.displayName, r.body.rackLocation, r.body.reorderLevel], [200, 'Edited', 'R2', 5]);
  for (const identity of [{ baseUnit: 'ML' }, { trackBatches: false }, { masterId: NONEXIST }]) {
    assert.equal((await A.owner.call(itemPatch, { method: 'PATCH', body: identity, params: { id: a.body.id } })).body.code, 'UNKNOWN_FIELD');
  }
  const b = await B.owner.call(itemsPost, { body: custom('B item') });
  const cross = await A.owner.call(itemPatch, { method: 'PATCH', body: { displayName: 'Hijacked' }, params: { id: b.body.id } });
  assert.deepEqual([cross.status, cross.body.code], [404, 'ITEM_NOT_FOUND']);
  assert.equal((await B.owner.call(itemGet, { params: { id: b.body.id } })).body.displayName, 'B item');
});

test('E-16 / E-17 / DX-42: units: a fixed factor, flags only afterwards, the base unit stays; another organisation\'s item or unit is 404', async () => {
  const A = await world('dx42a');
  const B = await world('dx42b');
  const item = (await A.owner.call(itemsPost, { body: custom('Strip tablets') })).body;
  const strip = await A.owner.call(unitPost, { body: { name: 'strip', baseUnitsPerUnit: 15 }, params: { id: item.id } });
  assert.deepEqual([strip.status, strip.body.baseUnitsPerUnit, strip.body.isBase], [201, 15, false]);
  assert.equal((await A.owner.call(unitPost, { body: { name: 'STRIP', baseUnitsPerUnit: 10 }, params: { id: item.id } })).body.code, 'UNIT_NAME_TAKEN');
  assert.equal((await A.owner.call(unitPatch, { method: 'PATCH', body: { baseUnitsPerUnit: 10 }, params: { id: item.id, unitId: strip.body.id } })).body.code, 'UNKNOWN_FIELD');
  const flags = await A.owner.call(unitPatch, { method: 'PATCH', body: { dispensable: false }, params: { id: item.id, unitId: strip.body.id } });
  assert.deepEqual([flags.status, flags.body.dispensable, flags.body.baseUnitsPerUnit], [200, false, 15]);
  const base = item.units[0];
  assert.equal((await A.owner.call(unitPatch, { method: 'PATCH', body: { active: false }, params: { id: item.id, unitId: base.id } })).body.code, 'BASE_UNIT_REQUIRED');
  const sql = await inOrg(A.org.orgId, (c) => c.query('UPDATE item_units SET base_units_per_unit = 10 WHERE id = $1', [strip.body.id])).then(() => 'ok', (e) => e.hint);
  assert.equal(sql, 'UNIT_IMMUTABLE');
  const bItem = (await B.owner.call(itemsPost, { body: custom('B strips') })).body;
  const add = await A.owner.call(unitPost, { body: { name: 'box', baseUnitsPerUnit: 100 }, params: { id: bItem.id } });
  const patch = await A.owner.call(unitPatch, { method: 'PATCH', body: { active: false }, params: { id: bItem.id, unitId: bItem.units[0].id } });
  assert.deepEqual([add.status, add.body.code, patch.status, patch.body.code], [404, 'ITEM_NOT_FOUND', 404, 'ITEM_NOT_FOUND']);
  const units = await inOrg(B.org.orgId, async (c) => Number((await c.query('SELECT count(*) AS n FROM item_units WHERE item_id = $1', [bItem.id])).rows[0].n));
  assert.equal(units, 1, 'no unit created');
});

test('E-20 / E-21 / DX-45: suppliers with a derived licence status; another organisation\'s is excluded and 404', async () => {
  const A = await world('dx45a');
  const B = await world('dx45b');
  const mk = (name: string, extra: Record<string, unknown>) => A.owner.call(suppliersPost, { body: { name, ...extra } });
  const statuses = await Promise.all([
    mk('No Licence Traders', {}), mk('Undated Distributors', { drugLicenceNumbers: ['20B/1'] }),
    mk('Lapsed Distributors', { drugLicenceNumbers: ['20B/2'], licenceValidTill: '2020-01-31' }),
    mk('Licensed Distributors', { drugLicenceNumbers: ['20B/3', '21B/3'], licenceValidTill: '2099-12-31', gstin: '24AAAAA0000A1Z5', contactPhone: '+919800000050' }),
  ]);
  assert.deepEqual(statuses.map((r) => r.body.licenceStatus), ['MISSING', 'VALIDITY_UNKNOWN', 'EXPIRED', 'VALID']);
  assert.equal((await mk('licensed distributors', {})).body.code, 'SUPPLIER_NAME_TAKEN');
  assert.equal((await mk('Bad Phone Co', { contactPhone: '98000 00050' })).status, 422);
  const bSup = (await B.owner.call(suppliersPost, { body: { name: 'B Supplier' } })).body;
  assert.ok(!(await A.owner.call(suppliersGet)).body.items.some((x: { id: string }) => x.id === bSup.id));
  assert.equal((await A.owner.call(supplierGet, { params: { id: bSup.id } })).body.code, 'SUPPLIER_NOT_FOUND');
  const p = await A.owner.call(supplierPatch, { method: 'PATCH', body: { name: 'Hijacked' }, params: { id: bSup.id } });
  assert.deepEqual([p.status, p.body.code], [404, 'SUPPLIER_NOT_FOUND']);
  assert.equal((await B.owner.call(supplierGet, { params: { id: bSup.id } })).body.name, 'B Supplier');
  const ok = await A.owner.call(supplierPatch, { method: 'PATCH', body: { licenceValidTill: '2030-06-30' }, params: { id: statuses[1].body.id } });
  assert.deepEqual([ok.status, ok.body.licenceStatus], [200, 'VALID']);
});

test('DPN-08 (premises.legal_settings): no grant, or one for another premises, is 401', async () => {
  const A = await world('dpn8c', { setup: false });
  await A.owner.call(setupPost, { body: {} });
  const id = A.org.premisesId;
  assert.equal((await A.owner.call(premisesSetup, { body: PREMISES, params: { id }, headers: { 'reauth-grant': await grant(A, 'premises.legal_settings', A.second) } })).body.code, 'reauth_required');
  assert.equal((await A.owner.call(premisesSetup, { body: PREMISES, params: { id }, headers: { 'reauth-grant': await grant(A, 'org.settings', A.org.orgId) } })).body.code, 'reauth_required');
  assert.equal((await A.owner.call(premisesSetup, { body: PREMISES, params: { id }, headers: { 'reauth-grant': await grant(A, 'premises.legal_settings', id) } })).status, 201);
});

test('schema (013 … 018): history is append-only; the app never deletes catalogue rows', async () => {
  const A = await world('sch5');
  for (const t of ['items', 'item_units', 'suppliers', 'stock_locations', 'stock_settings', 'premises_settings', 'stock_settings_history']) {
    assert.equal(await inOrg(A.org.orgId, (c) => c.query(`DELETE FROM ${t}`)).then(() => 'ok', (e) => e.code), '42501', t);
  }
  const owner = await as('migrator', async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [A.org.orgId]);
    const r = await c.query("UPDATE premises_settings_history SET version = 9").then(() => 'ok', (e) => e.hint);
    await c.query('ROLLBACK');
    return r;
  });
  assert.equal(owner, 'LEDGER_APPEND_ONLY');
});
