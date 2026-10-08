import { gated, json } from '@/lib/http/api';
import { clearSessionCookie } from '@/lib/http/cookies';
import { AuthError } from '@/lib/http/errors';
import { emptyBody } from '@/lib/http/body';
import { sessionFromRequest } from '@/lib/auth/guard';
import { signOut } from '@/lib/auth/account';

export const dynamic = 'force-dynamic';

/**
 * A-06: ends this session. On a trusted PC the person leaves the lock screen; it works on a
 * locked PC too. Always answers 200 and clears the cookie, even if the session had already ended.
 */
export const POST = gated(async (req: Request) => {
  await emptyBody(req);
  try {
    await signOut(await sessionFromRequest(req, { allowMustChange: true, allowNoSwitchPin: true, allowLocked: true }));
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
  }
  return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie() } });
});
