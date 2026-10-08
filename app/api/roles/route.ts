import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { listRoles, createRole } from '@/lib/admin/roles';

export const dynamic = 'force-dynamic';

/** M-09 GET: roles with their effective permissions and overrides. */
export const GET = withSession({ permission: 'roles.manage' }, async (_req, _ctx, s) => json({ items: await listRoles(s) }));

/** M-09 POST: a custom role and its grants (`roles.manage` grant). */
export const POST = withSession({ permission: 'roles.manage' }, async (req, _ctx, s) => {
  const body = await strictBody(req, {
    key: { type: 'string', min: 2, max: 32 },
    name: { type: 'string', min: 1, max: 64 },
    grants: { type: 'flags', max: 60 },
  });
  return json(await createRole(s, body, grantFromRequest(req)), { status: 201 });
});
