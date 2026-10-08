// Builders for the generated tenant-integrity tests (06b DS-20, DS-21).
//
// DS-20: one entry per FK between tenant tables (named by constraint). It inserts, inside
//        withTenant(A), a row whose reference points at org B's parent row, and returns the
//        Postgres error code (expected '23503').
// DS-21: one entry per unique index on a tenant table. It inserts the same key in A and in
//        B (expected 'ok'), then again in A (expected '23505').
//
// The tests compare these maps with the catalog: a new FK or unique without a builder fails.
import pg from 'pg';
import { urls, pgCode } from './env';
import { withTenant } from '../../lib/db/tenant';
import type { OrgFixture } from './fixtures';

type FkBuilder = (a: OrgFixture, b: OrgFixture) => Promise<string>;
type UniqueBuilder = (a: OrgFixture, b: OrgFixture) => Promise<{ otherOrg: string; sameOrg: string }>;

async function inTenant(org: OrgFixture, sql: string, params: unknown[]): Promise<string> {
  const pool = new pg.Pool({ connectionString: urls.app, max: 1 });
  try {
    return await pgCode(withTenant(org.orgId, (db) => db.rows(sql, params), pool)).then((c) => (c === 'no-error' ? 'ok' : c));
  } finally {
    await pool.end();
  }
}

/** Milestone 1 PR 1 has no FK between two tenant tables yet (premises → organisations is the reviewed root FK). */
export const FK_BUILDERS: Record<string, FkBuilder> = {};

export const UNIQUE_BUILDERS: Record<string, UniqueBuilder> = {
  async premises_name_key(a, b) {
    const sql = 'INSERT INTO premises (org_id, name, address, state_code) VALUES ($1, $2, $3, $4)';
    const name = 'Counter Two';
    const first = await inTenant(a, sql, [a.orgId, name, 'x', '24']);
    if (first !== 'ok') return { otherOrg: `setup failed: ${first}`, sameOrg: '' };
    const otherOrg = await inTenant(b, sql, [b.orgId, name.toUpperCase(), 'x', '24']);
    const sameOrg = await inTenant(a, sql, [a.orgId, name.toLowerCase(), 'x', '24']);
    return { otherOrg, sameOrg };
  },
};
