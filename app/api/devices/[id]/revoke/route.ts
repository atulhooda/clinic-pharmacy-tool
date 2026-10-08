import { json } from '@/lib/http/api';
import { emptyBody, UUID_PATTERN } from '@/lib/http/body';
import { HttpError } from '@/lib/http/errors';
import { withSession } from '@/lib/http/session-route';
import { revokeDevice } from '@/lib/admin/devices';

export const dynamic = 'force-dynamic';

/** M-11: revoke a trusted PC; every session on it ends at its next request. */
export const POST = withSession<{ params: { id: string } }>({ permission: 'devices.manage' }, async (req, ctx, s) => {
  await emptyBody(req);
  if (!UUID_PATTERN.test(ctx.params.id)) throw new HttpError(404, 'DEVICE_NOT_FOUND', 'No such device.');
  return json({ ok: true, ...(await revokeDevice(s, ctx.params.id)) });
});
