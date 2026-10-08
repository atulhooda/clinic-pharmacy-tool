import { gated, json } from './api';
import { HttpError } from './errors';
import { IdempotentReplay, KEY_PATTERN, WRITE_METHODS, isExempt, readBody, requestHash, runIdempotent } from './idempotency';
import { sessionFromRequest, type GuardOptions, type Session } from '../auth/guard';

export interface RouteOptions<C> extends GuardOptions {
  /**
   * For a write route (06a §12.2): the status it answers on success, and how a replay re-reads
   * the resource: from its id (as the claiming transaction returned it), the path, or the
   * request body (parsed JSON). Without `replay`, a replay answers `{ id }`.
   */
  idempotent?: {
    status: number;
    replay?: (s: Session, resourceId: string | null, ctx: C, body: Record<string, unknown>) => Promise<unknown>;
  };
}

/**
 * Route order (06a §12.1): 1. the self-check gate; 2. the session guard (and the permission);
 * 3. for a write, the Idempotency-Key (§12.2); 4. the work. AuthError and HttpError become
 * their own responses inside gated().
 */
export function withSession<C = unknown>(
  opts: RouteOptions<C>,
  handler: (req: Request, ctx: C, session: Session) => Promise<Response>,
): (req: Request, ctx: C) => Promise<Response> {
  return gated<C>(async (req, ctx) => {
    const s = await sessionFromRequest(req, opts);
    const method = req.method.toUpperCase();
    const path = new URL(req.url).pathname;
    if (!WRITE_METHODS.has(method) || isExempt(path)) return handler(req, ctx, s);

    const key = req.headers.get('idempotency-key');
    if (!key) throw new HttpError(400, 'IDEMPOTENCY_KEY_REQUIRED', 'This request needs an Idempotency-Key header.');
    if (!KEY_PATTERN.test(key)) throw new HttpError(400, 'IDEMPOTENCY_KEY_INVALID', 'An Idempotency-Key is 8–128 letters, digits, - or _.');
    const status = opts.idempotent?.status ?? 200;
    const sent = await readBody(req);
    try {
      return await runIdempotent({ key, sha: requestHash(method, path, sent), method, path, status }, () => handler(req, ctx, s));
    } catch (err) {
      if (!(err instanceof IdempotentReplay)) throw err;
      const parsed = (sent.json && typeof sent.json === 'object' ? sent.json : {}) as Record<string, unknown>;
      const body = opts.idempotent?.replay ? await opts.idempotent.replay(s, err.resourceId, ctx, parsed) : { id: err.resourceId };
      return json(body, { status: err.status, headers: { 'idempotent-replayed': 'true' } });
    }
  });
}
