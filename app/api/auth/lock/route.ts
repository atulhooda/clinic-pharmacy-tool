import { json } from '@/lib/http/api';
import { emptyBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { withTenant } from '@/lib/db/tenant';
import { lockDevice } from '@/lib/auth/guard';
import { deviceRequired } from '@/lib/auth/switch';

export const dynamic = 'force-dynamic';

/** A-09 (06a §3.5): "Switch person". Locks this trusted PC at once; no session ends. */
export const POST = withSession({}, async (req, _ctx, s) => {
  await emptyBody(req);
  if (!s.deviceId) throw deviceRequired();
  await withTenant(s.orgId, (db) => lockDevice(db, s.orgId, s.deviceId!, s.sid, 'switch_person'));
  return json({ ok: true });
});
