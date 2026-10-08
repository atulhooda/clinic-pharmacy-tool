import { gated, json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { sessionCookie } from '@/lib/http/cookies';
import { clientIp } from '@/lib/auth/limits';
import { signInWithPassword } from '@/lib/auth/signin';
import { deviceFromRequest, deviceCookie, clearDeviceCookie } from '@/lib/auth/device';

export const dynamic = 'force-dynamic';

/**
 * A-02 (06a §12.3): password sign-in. Public. Milestone 1 has no phone OTP (D-39). On a trusted
 * PC the device cookie's organisation wins and the session is bound to the device.
 */
export const POST = gated(async (req: Request) => {
  const body = await strictBody(req, {
    orgSlug: { type: 'string', min: 3, max: 40 },
    login: { type: 'string', min: 1, max: 64 },
    password: { type: 'string', min: 1, max: 256 },
  });
  const claim = await deviceFromRequest(req);
  const result = await signInWithPassword(body, clientIp(req), claim);
  const headers = new Headers([['set-cookie', sessionCookie(result.token, result.expiresAt)]]);
  if (result.deviceId && claim) headers.append('set-cookie', deviceCookie(claim.token));
  if (result.staleDeviceCookie) headers.append('set-cookie', clearDeviceCookie());
  return json({ ok: true, next: result.next, trustedDevice: result.deviceId !== null }, { headers });
});
