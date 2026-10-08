import { gated, json } from '@/lib/http/api';
import { strictBody, UUID_PATTERN } from '@/lib/http/body';
import { HttpError } from '@/lib/http/errors';
import { sessionCookie } from '@/lib/http/cookies';
import { deviceFromRequest, deviceCookie } from '@/lib/auth/device';
import { switchPerson, deviceRequired } from '@/lib/auth/switch';

export const dynamic = 'force-dynamic';

/** A-11 (06a §3.5): switch to another open session on this PC with that person's switch PIN. */
export const POST = gated(async (req: Request) => {
  const claim = await deviceFromRequest(req);
  if (!claim) throw deviceRequired();
  const body = await strictBody(req, { sessionId: { type: 'string', max: 36 }, pin: { type: 'string', min: 1, max: 16 } });
  if (!UUID_PATTERN.test(body.sessionId)) throw new HttpError(404, 'SESSION_NOT_FOUND', 'That person is not signed in on this PC.');
  const r = await switchPerson(claim, body.sessionId, body.pin);
  const headers = new Headers([['set-cookie', sessionCookie(r.token, r.expiresAt)], ['set-cookie', deviceCookie(claim.token)]]);
  return json({ ok: true }, { headers });
});
