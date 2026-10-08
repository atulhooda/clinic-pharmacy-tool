import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { setSigningPin } from '@/lib/auth/account';

export const dynamic = 'force-dynamic';

/**
 * A-15 (06a §3.7): set or change my signing PIN, with my password in the same request (an OTP
 * in Milestone 2). Only for people whose role holds a PIN-gated permission (D-33).
 */
export const PUT = withSession({}, async (req, _ctx, s) => {
  const body = await strictBody(req, {
    pin: { type: 'string', min: 1, max: 16 },
    password: { type: 'string', min: 1, max: 256, optional: true },
  });
  await setSigningPin(s, body.pin, body.password);
  return json({ ok: true });
});
