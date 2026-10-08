import type { Pool } from 'pg';
import { getPool } from './pool';
import { wrap } from './db';

/**
 * 06a §2.4: the one lookup that crosses tenants, before there is a session. It goes through
 * auth_resolve_org(), which returns an ACTIVE organisation's id and display name only.
 */
export interface OrgRef {
  id: string;
  slug: string;
  displayName: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{2,39}$/;

export async function resolveOrgBySlug(slug: string, pool: Pool = getPool()): Promise<OrgRef | null> {
  const s = slug.trim().toLowerCase();
  if (!SLUG.test(s)) return null;
  const rows = await wrap(pool).rows<{ id: string; display_name: string }>('SELECT id, display_name FROM auth_resolve_org($1)', [s]);
  return rows[0] ? { id: rows[0].id, slug: s, displayName: rows[0].display_name } : null;
}
