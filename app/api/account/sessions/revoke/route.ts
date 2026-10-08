import { json } from '@/lib/http/api';
import { clearSessionCookie } from '@/lib/http/cookies';
import { withSession } from '@/lib/http/session-route';
import { revokeAllMySessions } from '@/lib/auth/account';

export const dynamic = 'force-dynamic';

/** A-16: end all my sessions, this one included. Self only. */
export const POST = withSession({}, async (_req, _ctx, s) => {
  const count = await revokeAllMySessions(s);
  return json({ ok: true, ended: count }, { headers: { 'set-cookie': clearSessionCookie() } });
});
