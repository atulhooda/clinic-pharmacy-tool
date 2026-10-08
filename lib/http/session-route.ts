import { gated } from './api';
import { sessionFromRequest, type GuardOptions, type Session } from '../auth/guard';

/**
 * Route order (06a §12.1): 1. the self-check gate; 2. the session guard (and the permission);
 * 3. the work. AuthError and HttpError become their own responses inside gated().
 */
export function withSession<C = unknown>(
  opts: GuardOptions,
  handler: (req: Request, ctx: C, session: Session) => Promise<Response>,
): (req: Request, ctx: C) => Promise<Response> {
  return gated<C>(async (req, ctx) => handler(req, ctx, await sessionFromRequest(req, opts)));
}
