import { cookies } from 'next/headers';
import { sessionFromToken, type GuardOptions, type Session } from './guard';
import { SESSION_COOKIE } from './token';
import { DEVICE_COOKIE, readDeviceToken } from './device';
import { AuthError } from '../http/errors';
import { getSchemaStatus } from '../db/selfcheck';

/**
 * For server-rendered pages: the signed-in session, or null with the guard's code (e.g.
 * `device_locked`, so a page can send a locked PC to the lock screen). Rendering a page is
 * never input (§3.6). Pages never render tenant data when the self-check fails (06a §2.5).
 */
export interface PageSession {
  session: Session | null;
  available: boolean;
  code: string | null;
  /** The browser holds a (signature-valid) trusted-device cookie. */
  onDevice: boolean;
}

export async function pageSession(opts: GuardOptions = {}): Promise<PageSession> {
  if (!(await getSchemaStatus()).ok) return { session: null, available: false, code: null, onDevice: false };
  const jar = cookies();
  const device = await readDeviceToken(jar.get(DEVICE_COOKIE)?.value);
  try {
    const session = await sessionFromToken(jar.get(SESSION_COOKIE)?.value, device,
      { allowMustChange: true, allowNoSwitchPin: true, ...opts, mutating: false });
    return { session, available: true, code: null, onDevice: device !== null };
  } catch (err) {
    if (err instanceof AuthError) return { session: null, available: true, code: err.code, onDevice: device !== null };
    throw err;
  }
}
