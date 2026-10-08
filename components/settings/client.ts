'use client';

/** A fresh Idempotency-Key (06a §12.2). A dialog makes one per confirm, so a double click reuses it. */
export const newIdempotencyKey = (): string => crypto.randomUUID();

/**
 * A small fetch wrapper for the app's screens: JSON in and out, the grant and If-Match headers,
 * and an Idempotency-Key on every write (a fresh one unless the caller passes its own).
 */
export async function api<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown; grant?: string | null; ifMatch?: string; idempotencyKey?: string } = {},
): Promise<{ ok: boolean; status: number; body: T & { code?: string; error?: string } }> {
  const method = opts.method ?? (opts.body !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.grant) headers['reauth-grant'] = opts.grant;
  if (opts.ifMatch) headers['if-match'] = opts.ifMatch;
  if (method !== 'GET') headers['idempotency-key'] = opts.idempotencyKey ?? newIdempotencyKey();
  const res = await fetch(path, { method, headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const body = (await res.json().catch(() => ({}))) as T & { code?: string; error?: string };
  if (res.status === 401 && ['session_revoked', 'session_expired', 'device_locked', 'unauthenticated'].includes(body.code ?? '')) {
    window.location.assign('/');
  }
  return { ok: res.ok, status: res.status, body };
}
