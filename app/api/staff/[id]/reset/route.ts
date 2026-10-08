import { json } from '@/lib/http/api';
import { emptyBody, UUID_PATTERN } from '@/lib/http/body';
import { HttpError } from '@/lib/http/errors';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { resetStaff } from '@/lib/admin/staff';

export const dynamic = 'force-dynamic';

/** M-07: a new one-time password (returned once); both PINs cleared; every session ended (`staff.manage` grant). */
export const POST = withSession<{ params: { id: string } }>({ permission: 'staff.manage' }, async (req, ctx, s) => {
  await emptyBody(req);
  if (!UUID_PATTERN.test(ctx.params.id)) throw new HttpError(404, 'STAFF_NOT_FOUND', 'No such person.');
  return json(await resetStaff(s, ctx.params.id.toLowerCase(), grantFromRequest(req)));
});
