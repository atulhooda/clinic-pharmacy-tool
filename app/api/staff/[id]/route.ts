import { json } from '@/lib/http/api';
import { strictBody, UUID_PATTERN } from '@/lib/http/body';
import { HttpError } from '@/lib/http/errors';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { getStaff, patchStaff } from '@/lib/admin/staff';

export const dynamic = 'force-dynamic';
type Ctx = { params: { id: string } };
const id = (ctx: Ctx) => {
  if (!UUID_PATTERN.test(ctx.params.id)) throw new HttpError(404, 'STAFF_NOT_FOUND', 'No such person.');
  return ctx.params.id.toLowerCase();
};

/** M-06 GET. */
export const GET = withSession<Ctx>({ permission: 'staff.manage' }, async (_req, ctx, s) => json(await getStaff(s, id(ctx))));

/** M-06 PATCH: name, role, memberships, prescriber link, phone, active (`staff.manage` grant for the person). */
export const PATCH = withSession<Ctx>({ permission: 'staff.manage', idempotent: { status: 200, replay: (s, _rid, ctx) => getStaff(s, id(ctx)) } }, async (req, ctx, s) => {
  const body = await strictBody(req, {
    name: { type: 'string', min: 1, max: 64, optional: true },
    role: { type: 'string', min: 2, max: 32, optional: true },
    premisesIds: { type: 'uuid[]', max: 50, optional: true },
    phone: { type: 'string', max: 16, optional: true, nullable: true },
    prescriberId: { type: 'uuid', optional: true, nullable: true },
    active: { type: 'bool', optional: true },
  });
  return json(await patchStaff(s, id(ctx), body, grantFromRequest(req)));
});
