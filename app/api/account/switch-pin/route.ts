import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { setSwitchPin } from '@/lib/auth/account';

export const dynamic = 'force-dynamic';

/** A-14 (06a §3.5, §3.8): set or change my switch PIN. The one route open before it is set (06b DW-16). */
export const PUT = withSession({ allowNoSwitchPin: true }, async (req, _ctx, s) => {
  const body = await strictBody(req, { pin: { type: 'string', min: 1, max: 16 } });
  await setSwitchPin(s, body.pin);
  return json({ ok: true });
});
