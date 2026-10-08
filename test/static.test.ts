// Static guards: DH-12 (db access), DMG-08 / DMG-12 (migration rules), DX-76 (route inventory),
// and no secrets in the bootstrap or migrations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { checkDbAccess } from '../scripts/lib/check-db-access.mjs';
import { checkMigrationsDir } from '../scripts/lib/check-migrations.mjs';
import { ROUTES, type Method } from '../lib/routes';

const ROOT = process.cwd();

function tempTree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pharmacy-static-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

test('DH-12: the repo reaches the database only through lib/db and never uses parseFloat', () => {
  assert.deepEqual(checkDbAccess(ROOT), []);
});

test('DH-12: the access check catches .query( outside lib/db and parseFloat anywhere', () => {
  const dir = tempTree({
    'app/api/x/route.ts': 'await client.query("SELECT 1");\n',
    'lib/db/fine.ts': 'await client.query("SELECT 1");\n',
    'lib/money.ts': 'const rupees = parseFloat(s);\n',
  });
  const problems = checkDbAccess(dir);
  assert.equal(problems.length, 2, problems.join('\n'));
  assert.ok(problems[0].startsWith(path.join('app', 'api', 'x', 'route.ts') + ':1'));
  assert.ok(problems[1].includes('parseFloat'));
});

test('DMG-08 / DMG-12: the repo migrations pass the static rules', () => {
  assert.deepEqual(checkMigrationsDir(path.join(ROOT, 'migrations')), []);
});

test('DMG-08 / DMG-12: the static rules catch gaps, transaction control, and destructive changes to earlier tables', () => {
  const base = 'CREATE TABLE t1 (org_id uuid, id uuid);\nALTER TABLE t1 ENABLE ROW LEVEL SECURITY;\n';
  assert.match(checkMigrationsDir(tempTree({ '001_a.sql': base, '003_c.sql': 'SELECT 1;' }))[0], /no gaps or duplicates/);
  assert.deepEqual(checkMigrationsDir(tempTree({ '001_a.sql': base, '002_b.sql': 'ALTER TABLE t1 ADD COLUMN note text;\nCREATE INDEX t1_note ON t1 (note);' })), [],
    'adding to an earlier table is allowed');
  const bad = checkMigrationsDir(tempTree({
    '001_a.sql': base,
    '002_b.sql': [
      'ALTER TABLE t1 DROP COLUMN id;',
      'ALTER TABLE t1 RENAME TO t2;',
      'ALTER TABLE t1 ALTER COLUMN id TYPE text;',
      'ALTER TABLE t1 NO FORCE ROW LEVEL SECURITY;',
      'DROP TABLE t1;',
      'COMMIT;',
      "CREATE FUNCTION f() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END $$;",
      "SELECT 'DROP TABLE t1';",
    ].join('\n'),
  }));
  assert.equal(bad.length, 6, bad.join('\n')); // 4 ALTERs + DROP + COMMIT; the function body and the string don't count
});

test('DX-76: every route method is in the route table, and every endpoint route has a cross-tenant row in 06b', () => {
  const found: { path: string; methods: Method[] }[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'route.ts') {
        const src = fs.readFileSync(p, 'utf8');
        const methods = [...src.matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1] as Method);
        const urlPath = '/' + path.relative(path.join(ROOT, 'app'), path.dirname(p)).split(path.sep).join('/');
        found.push({ path: urlPath, methods: methods.sort() });
      }
    }
  };
  walk(path.join(ROOT, 'app', 'api'));
  assert.ok(found.length > 0);
  const spec = fs.readFileSync(path.join(ROOT, 'docs/specs/06b-dispensary-ledger.acceptance.md'), 'utf8');
  const dxRows = spec.split('\n').filter((l) => /^\| DX-\d+ \|/.test(l));
  for (const r of found) {
    const entry = ROUTES.find((e) => e.path === r.path);
    assert.ok(entry, `${r.path} is not in lib/routes.ts`);
    assert.deepEqual([...entry.methods].sort(), r.methods, `${r.path}: methods differ from lib/routes.ts`);
    if (entry.endpoint) {
      assert.ok(dxRows.some((l) => new RegExp(`\\b${entry.endpoint}\\b`).test(l)), `${entry.endpoint} has no DX row in 06b`);
    } else {
      assert.ok(entry.isolationNote && entry.isolationNote.length > 10, `${r.path}: an operational route needs an isolation note`);
    }
  }
  for (const e of ROUTES) assert.ok(found.some((r) => r.path === e.path), `lib/routes.ts lists ${e.path}, which does not exist`);
});

test('no passwords or secrets in the bootstrap script or migrations', () => {
  const files = [path.join(ROOT, 'ops', 'bootstrap-roles.sql'),
    ...fs.readdirSync(path.join(ROOT, 'migrations')).map((f) => path.join(ROOT, 'migrations', f))];
  for (const f of files) {
    const sql = fs.readFileSync(f, 'utf8').replace(/--[^\n]*/g, '');
    assert.ok(!/\bPASSWORD\s+'/i.test(sql), `${path.basename(f)} sets a password`);
  }
});
