import { gated, json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { sessionCookie } from '@/lib/http/cookies';
import { clientIp } from '@/lib/auth/limits';
import { signInWithPassword } from '@/lib/auth/signin';

export const dynamic = 'force-dynamic';

/** A-02 (06a §12.3): password sign-in. Public. Milestone 1 has no phone OTP (D-39). */
export const POST = gated(async (req: Request) => {
  const body = await strictBody(req, {
    orgSlug: { type: 'string', min: 3, max: 40 },
    login: { type: 'string', min: 1, max: 64 },
    password: { type: 'string', min: 1, max: 256 },
  });
  const result = await signInWithPassword(body, clientIp(req));
  return json({ ok: true, next: result.next }, { headers: { 'set-cookie': sessionCookie(result.token, result.expiresAt) } });
});
