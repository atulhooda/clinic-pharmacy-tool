// Synthetic organisations and premises, created the way production creates them:
// by pharmacy_ops (the founder CLI role), inside a transaction that sets app.org_id.
import { randomUUID } from 'crypto';
import { as, type Urls, urls as mainUrls } from './env';

export interface OrgFixture {
  orgId: string;
  slug: string;
  premisesId: string;
}

export async function createOrg(
  label: string,
  opts: { status?: 'ACTIVE' | 'SUSPENDED'; premisesName?: string; from?: Urls } = {},
): Promise<OrgFixture> {
  const orgId = randomUUID();
  const premisesId = randomUUID();
  const slug = `${label}-${orgId.slice(0, 8)}`.toLowerCase();
  await as('ops', async (c) => {
    await c.query('BEGIN');
    await c.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    await c.query('INSERT INTO organisations (id, slug, display_name, status) VALUES ($1, $2, $3, $4)',
      [orgId, slug, `Synthetic ${label}`, opts.status ?? 'ACTIVE']);
    await c.query('INSERT INTO premises (org_id, id, name, address, state_code) VALUES ($1, $2, $3, $4, $5)',
      [orgId, premisesId, opts.premisesName ?? 'Main', '1 Test Road, Gujarat', '24']);
    await c.query('COMMIT');
  }, opts.from ?? mainUrls);
  return { orgId, slug, premisesId };
}
