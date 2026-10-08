/**
 * An error a route turns into { error, code, requestId, details? } (06a §5). Lower-case codes
 * are identity and access; upper-case codes are domain codes.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
  }
}

/** Identity and access failures (401/403), raised by the session guard. */
export class AuthError extends HttpError {}
