import { json } from '@/lib/http/api';
import { emptyBody, UUID_PATTERN } from '@/lib/http/body';
import { HttpError } from '@/lib/http/errors';
import { withSession } from '@/lib/http/session-route';
import { getStaff, revokeStaffSessions } from '@/lib/admin/staff';

export const dynamic = 'force-dynamic';

/** M-08: end every session of this person. */
export const POST = withSession<{ params: { id: string } }>({ permission: 'staff.manage', idempotent: { status: 200,
  replay: async (s, _rid, ctx) => ({ staff: await getStaff(s, ctx.params.id.toLowerCase()) }) } }, async (req, ctx, s) => {
  await emptyBody(req);
  if (!UUID_PATTERN.test(ctx.params.id)) throw new HttpError(404, 'STAFF_NOT_FOUND', 'No such person.');
  return json(await revokeStaffSessions(s, ctx.params.id.toLowerCase()));
});
