import { json } from '@/lib/http/api';
import { strictBody, UUID_PATTERN } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { deviceFromRequest, deviceCookie } from '@/lib/auth/device';
import { grantFromRequest } from '@/lib/auth/reauth';
import { listDevices, registerDevice } from '@/lib/admin/devices';

export const dynamic = 'force-dynamic';

/** M-10 GET: the organisation's trusted PCs. */
export const GET = withSession({ permission: 'devices.manage' }, async (req, _ctx, s) => {
  const claim = await deviceFromRequest(req);
  return json({ items: await listDevices(s, claim?.org === s.orgId ? claim.deviceId : null) });
});

/** M-10 POST: trust THIS browser (a `devices.register` grant for the organisation). */
export const POST = withSession({ permission: 'devices.manage', idempotent: { status: 201, replay: async (s, rid) => {
  // A replay cannot hand out the device token again; the device itself is re-read.
  const d = (await listDevices(s, null)).find((x) => x.id === rid);
  return { device: d ? { id: d.id, name: d.name } : null };
} } }, async (req, _ctx, s) => {
  const body = await strictBody(req, {
    name: { type: 'string', min: 1, max: 64 },
    premisesId: { type: 'string', pattern: UUID_PATTERN },
  });
  const r = await registerDevice(s, body, grantFromRequest(req));
  return json({ device: r.device }, { status: 201, headers: { 'set-cookie': deviceCookie(r.token) } });
});
