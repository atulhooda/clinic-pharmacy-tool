import { gated, json } from '@/lib/http/api';
import { deviceFromRequest, deviceCookie } from '@/lib/auth/device';
import { lockScreen } from '@/lib/auth/switch';

export const dynamic = 'force-dynamic';

/**
 * A-10 (06a §3.5): the "Who's working?" list for this trusted PC: names and roles of the people
 * with an open session on it. Needs the device cookie, not a session (06b DW-14).
 */
export const GET = gated(async (req: Request) => {
  const claim = await deviceFromRequest(req);
  const screen = await lockScreen(claim);
  return json(screen, { headers: { 'set-cookie': deviceCookie(claim!.token) } });
});
