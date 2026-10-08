import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { HttpError } from '@/lib/http/errors';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { patchRole } from '@/lib/admin/roles';

export const dynamic = 'force-dynamic';

/** M-09 PATCH: rename a custom role; set grant overrides (`roles.manage` grant). */
export const PATCH = withSession<{ params: { key: string } }>({ permission: 'roles.manage' }, async (req, ctx, s) => {
  const body = await strictBody(req, {
    name: { type: 'string', min: 1, max: 64, optional: true },
    grants: { type: 'flags', max: 60, optional: true },
  });
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(ctx.params.key)) throw new HttpError(404, 'ROLE_NOT_FOUND', 'No such role.');
  return json(await patchRole(s, ctx.params.key, body, grantFromRequest(req)));
});
