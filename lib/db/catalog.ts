import type { Db } from './db';

/**
 * Catalog-driven checks of 06a §2.3 and §2.6 (06b DS-07, DS-14, DS-18, DS-19, DMG-05, DMG-14).
 * They read pg_catalog only, never table data, so they run as any role.
 */

/** 06a §2.6 rule 5: the reviewed exceptions. 06b DMG-14 fails on anything else. */
export const REVIEWED_EXCEPTIONS = {
  /** Tables without org_id. */
  nonTenantTables: ['organisations', 'medicine_master', 'schema_migrations'],
  /** Single-column FKs from tenant tables to non-tenant tables. */
  foreignKeysToNonTenant: [
    { refTable: 'organisations', cols: ['org_id'], refCols: ['id'] },
    { refTable: 'medicine_master', cols: ['master_id'], refCols: ['id'] },
    { refTable: 'medicine_master', cols: ['matched_master_id'], refCols: ['id'] },
  ],
  /** Policies other than tenant_isolation. */
  policies: [
    { table: 'organisations', policy: 'org_directory' },
    { table: 'master_correction_requests', policy: 'curation_select' },
    { table: 'master_correction_requests', policy: 'curation_update' },
  ],
} as const;

/**
 * 06a §2.6 rule 3: rows that name stock must reference these parents with premises_id
 * in the FK, so nothing can draw on another branch's stock. Tables appear here before
 * they exist; the rule applies as soon as they do.
 */
export const PREMISES_SCOPED_PARENTS = [
  'batches', 'stock_locations', 'stock_movements',
  'goods_receipts', 'goods_receipt_lines',
  'dispenses', 'dispense_lines', 'dispense_allocations',
  'patient_returns', 'patient_return_lines',
  'stock_adjustments', 'stock_adjustment_lines',
  'supplier_returns', 'supplier_return_lines',
  'procedure_uses', 'procedure_use_lines', 'procedure_use_allocations',
  'opened_containers', 'stock_imports',
] as const;

export interface TableInfo {
  name: string;
  hasOrg: boolean;
  hasPremises: boolean;
  rls: boolean;
  forceRls: boolean;
}

export interface ConstraintInfo {
  name: string;
  type: 'p' | 'u' | 'x' | 'f';
  table: string;
  refTable: string | null;
  cols: string[];
  refCols: string[];
  onDelete: string;
}

export interface UniqueIndexInfo {
  name: string;
  table: string;
  primary: boolean;
  cols: string[];
  def: string;
}

export async function listTables(db: Db): Promise<TableInfo[]> {
  return db.rows<TableInfo>(`
    SELECT c.relname AS name,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped) AS "hasOrg",
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'premises_id' AND NOT a.attisdropped) AS "hasPremises",
           c.relrowsecurity AS rls, c.relforcerowsecurity AS "forceRls"
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
     ORDER BY c.relname`);
}

export async function listConstraints(db: Db): Promise<ConstraintInfo[]> {
  return db.rows<ConstraintInfo>(`
    SELECT con.conname AS name, con.contype AS type, c.relname AS "table", p.relname AS "refTable",
           ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(n, i)
                   JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.n ORDER BY k.i) AS cols,
           ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(n, i)
                   JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.n ORDER BY k.i) AS "refCols",
           con.confdeltype AS "onDelete"
      FROM pg_constraint con
      JOIN pg_class c ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_class p ON p.oid = con.confrelid
     WHERE n.nspname = 'public' AND con.contype IN ('p', 'u', 'x', 'f')
     ORDER BY c.relname, con.conname`);
}

export async function listUniqueIndexes(db: Db): Promise<UniqueIndexInfo[]> {
  return db.rows<UniqueIndexInfo>(`
    SELECT i.relname AS name, t.relname AS "table", x.indisprimary AS primary,
           ARRAY(SELECT a.attname::text FROM unnest(x.indkey::int2[]) WITH ORDINALITY k(n, ord)
                   JOIN pg_attribute a ON a.attrelid = x.indrelid AND a.attnum = k.n
                  WHERE k.n > 0 ORDER BY k.ord) AS cols,
           pg_get_indexdef(x.indexrelid) AS def
      FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_class t ON t.oid = x.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname = 'public' AND x.indisunique
     ORDER BY t.relname, i.relname`);
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/** DS-18, DMG-05: keys, uniques and the org_id column. */
export async function checkKeys(db: Db): Promise<string[]> {
  const problems: string[] = [];
  const tables = await listTables(db);
  const constraints = await listConstraints(db);
  const uniques = await listUniqueIndexes(db);
  const tenant = new Set(tables.filter((t) => t.hasOrg).map((t) => t.name));

  for (const t of tables) {
    if (!t.hasOrg && !(REVIEWED_EXCEPTIONS.nonTenantTables as readonly string[]).includes(t.name)) {
      problems.push(`table ${t.name} has no org_id and is not a reviewed exception`);
    }
  }
  for (const name of tenant) {
    const pk = constraints.find((c) => c.table === name && c.type === 'p');
    if (!pk || !same(pk.cols, ['org_id', 'id'])) {
      problems.push(`table ${name}: primary key must be (org_id, id), found (${pk ? pk.cols.join(', ') : 'none'})`);
    }
  }
  for (const u of uniques) {
    if (tenant.has(u.table) && !u.cols.includes('org_id')) {
      problems.push(`unique index ${u.name} on ${u.table} does not include org_id`);
    }
  }
  for (const x of constraints.filter((c) => c.type === 'x')) {
    if (tenant.has(x.table) && !x.cols.includes('org_id')) {
      problems.push(`exclusion constraint ${x.name} on ${x.table} does not include org_id`);
    }
  }
  // DMG-05: org_id NOT NULL, no default, FK to organisations ON DELETE RESTRICT.
  const cols = await db.rows<{ table: string; notNull: boolean; hasDefault: boolean }>(`
    SELECT c.relname AS "table", a.attnotnull AS "notNull", a.atthasdef AS "hasDefault"
      FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND a.attname = 'org_id' AND NOT a.attisdropped`);
  for (const c of cols) {
    if (!c.notNull) problems.push(`table ${c.table}: org_id must be NOT NULL`);
    if (c.hasDefault) problems.push(`table ${c.table}: org_id must not have a default`);
    const fk = constraints.find((k) => k.table === c.table && k.type === 'f' && k.refTable === 'organisations' && same(k.cols, ['org_id']));
    if (!fk) problems.push(`table ${c.table}: missing FOREIGN KEY (org_id) REFERENCES organisations (id)`);
    else if (fk.onDelete !== 'r') problems.push(`table ${c.table}: the org_id FK must be ON DELETE RESTRICT`);
  }
  return problems;
}

/** DS-19, DMG-06: every FK between tenant tables is composite on org_id (and premises_id for stock). */
export async function checkForeignKeys(db: Db): Promise<string[]> {
  const problems: string[] = [];
  const tables = await listTables(db);
  const tenant = new Set(tables.filter((t) => t.hasOrg).map((t) => t.name));
  for (const fk of (await listConstraints(db)).filter((c) => c.type === 'f')) {
    if (!tenant.has(fk.table)) continue;
    const ref = fk.refTable ?? '?';
    if (tenant.has(ref)) {
      if (fk.cols[0] !== 'org_id' || fk.refCols[0] !== 'org_id' || fk.cols.length < 2) {
        problems.push(`FK ${fk.name} (${fk.table} → ${ref}) must start with org_id on both sides`);
      }
      if ((PREMISES_SCOPED_PARENTS as readonly string[]).includes(ref)
          && !(fk.cols.includes('premises_id') && fk.refCols.includes('premises_id'))) {
        problems.push(`FK ${fk.name} (${fk.table} → ${ref}) must include premises_id (06a §2.6 rule 3)`);
      }
    } else {
      const ok = REVIEWED_EXCEPTIONS.foreignKeysToNonTenant.some(
        (e) => e.refTable === ref && same(e.cols, fk.cols) && same(e.refCols, fk.refCols));
      if (!ok) problems.push(`FK ${fk.name} (${fk.table} → ${ref}) points at a non-tenant table and is not a reviewed exception`);
    }
  }
  return problems;
}

/** DS-07, DS-14: RLS enabled and forced, the tenant policy everywhere, no unreviewed policy. */
export async function checkRls(db: Db): Promise<string[]> {
  const problems: string[] = [];
  const tables = await listTables(db);
  const policies = await db.rows<{ table: string; policy: string; cmd: string; roles: string[]; qual: string | null; withCheck: string | null }>(`
    SELECT tablename AS "table", policyname AS policy, cmd, roles::text[] AS roles, qual, with_check AS "withCheck"
      FROM pg_policies WHERE schemaname = 'public'`);
  const scoped = tables.filter((t) => t.hasOrg || t.name === 'organisations');
  for (const t of scoped) {
    if (!t.rls || !t.forceRls) problems.push(`table ${t.name}: row-level security must be enabled and forced`);
    const p = policies.find((x) => x.table === t.name && x.policy === 'tenant_isolation');
    const key = t.name === 'organisations' ? 'id' : 'org_id';
    const expr = /current_setting\('app\.org_id'/;
    if (!p) {
      problems.push(`table ${t.name}: missing the tenant_isolation policy`);
    } else if (p.cmd !== 'ALL' || !p.roles.includes('public') || !p.qual || !p.withCheck
               || !expr.test(p.qual) || !expr.test(p.withCheck) || !p.qual.includes(`(${key} =`)) {
      problems.push(`table ${t.name}: tenant_isolation must apply to ALL commands for PUBLIC, comparing ${key} with app.org_id in USING and WITH CHECK`);
    }
  }
  for (const p of policies) {
    if (p.policy === 'tenant_isolation' && scoped.some((t) => t.name === p.table)) continue;
    const reviewed = REVIEWED_EXCEPTIONS.policies.some((e) => e.table === p.table && e.policy === p.policy);
    if (!reviewed) problems.push(`policy ${p.policy} on ${p.table} is not on the reviewed list`);
  }
  return problems;
}
