import { gated, json } from '@/lib/http/api';
import { clearSessionCookie } from '@/lib/http/cookies';
import { AuthError } from '@/lib/http/errors';
import { sessionFromRequest } from '@/lib/auth/guard';
import { signOut } from '@/lib/auth/account';

export const dynamic = 'force-dynamic';

/** A-06: ends this session. Always answers 200 and clears the cookie, even if the session had already ended. */
export const POST = gated(async (req: Request) => {
  try {
    await signOut(await sessionFromRequest(req, { allowMustChange: true }));
  } catch (err) {
    if (!(err instanceof AuthError)) throw err;
  }
  return json({ ok: true }, { headers: { 'set-cookie': clearSessionCookie() } });
});
