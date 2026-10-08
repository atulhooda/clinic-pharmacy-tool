import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { changePassword } from '@/lib/auth/account';

export const dynamic = 'force-dynamic';

/**
 * A-13: change my password. Allowed while a one-time password must still be changed. Wrong
 * current passwords count against this session (the 5th ends it). Other sessions end.
 */
export const PUT = withSession({ allowMustChange: true }, async (req, _ctx, s) => {
  const body = await strictBody(req, {
    current: { type: 'string', min: 1, max: 256 },
    next: { type: 'string', min: 1, max: 256 },
  });
  await changePassword(s, body.current, body.next);
  return json({ ok: true });
});
