import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { listStaff, createStaff } from '@/lib/admin/staff';

export const dynamic = 'force-dynamic';

/** M-05 GET: the organisation's staff. */
export const GET = withSession({ permission: 'staff.manage' }, async (_req, _ctx, s) => json({ items: await listStaff(s) }));

/** M-05 POST: create a person (`staff.manage` grant for the organisation). The one-time password is returned once. */
export const POST = withSession({ permission: 'staff.manage' }, async (req, _ctx, s) => {
  const body = await strictBody(req, {
    name: { type: 'string', min: 1, max: 64 },
    login: { type: 'string', min: 3, max: 32 },
    role: { type: 'string', min: 2, max: 32 },
    premisesIds: { type: 'uuid[]', max: 50 },
    phone: { type: 'string', max: 16, optional: true, nullable: true },
    prescriberId: { type: 'uuid', optional: true, nullable: true },
  });
  const r = await createStaff(s, body, grantFromRequest(req));
  return json(r, { status: 201 });
});
