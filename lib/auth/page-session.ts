import { cookies } from 'next/headers';
import { sessionFromToken, type Session } from './guard';
import { SESSION_COOKIE } from './token';
import { AuthError } from '../http/errors';
import { getSchemaStatus } from '../db/selfcheck';

/**
 * For server-rendered pages: the signed-in session, or null. Pages never render tenant data
 * when the schema is not verified (06a §2.5).
 */
export async function pageSession(): Promise<{ session: Session | null; available: boolean }> {
  if (!(await getSchemaStatus()).ok) return { session: null, available: false };
  try {
    const token = cookies().get(SESSION_COOKIE)?.value;
    return { session: await sessionFromToken(token, { allowMustChange: true, mutating: false }), available: true };
  } catch (err) {
    if (err instanceof AuthError) return { session: null, available: true };
    throw err;
  }
}
