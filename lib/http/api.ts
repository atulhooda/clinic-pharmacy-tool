import { randomUUID } from 'crypto';
import { getSchemaStatus } from '../db/selfcheck';
import { log } from '../log';
import { HttpError } from './errors';

/**
 * 06a §5 and §12.1: every error body is { error, code, requestId?, details? }.
 * Lower-case codes are identity and access; upper-case codes are domain codes.
 * `details` never echoes input values.
 */
export function apiError(status: number, code: string, message: string, details?: unknown, headers?: Record<string, string>): Response {
  const body: Record<string, unknown> = { error: message, code, requestId: randomUUID() };
  if (details !== undefined) body.details = details;
  return json(body, { status, headers });
}

/** JSON with `Cache-Control: no-store`: nothing this app returns should be cached. */
export function json(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.set('cache-control', 'no-store');
  return new Response(JSON.stringify(body), { ...init, headers });
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

/**
 * Route order, step 1 (06a §12.1): the self-check gate. Wraps every /api route except
 * /api/health. An HttpError becomes its own response; anything else becomes a 500 with a
 * request id, and the log line carries the error's code only, never input data.
 */
export function gated<C = unknown>(handler: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    const status = await getSchemaStatus();
    if (!status.ok) return apiError(503, 'SCHEMA_UNVERIFIED', 'The database is not in a verified state. Try again shortly.');
    try {
      return await handler(req, ctx);
    } catch (err) {
      if (err instanceof HttpError) return apiError(err.status, err.code, err.message, err.details, err.headers);
      const res = apiError(500, 'INTERNAL', 'Something went wrong.');
      log('route_error', { code: (err as { code?: string }).code ?? (err as Error).name });
      return res;
    }
  };
}
