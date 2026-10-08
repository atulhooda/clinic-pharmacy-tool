'use client';

/** A small fetch wrapper for the settings screens: JSON in and out, the grant and If-Match headers. */
export async function api<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown; grant?: string | null; ifMatch?: string } = {},
): Promise<{ ok: boolean; status: number; body: T & { code?: string; error?: string } }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.grant) headers['reauth-grant'] = opts.grant;
  if (opts.ifMatch) headers['if-match'] = opts.ifMatch;
  const res = await fetch(path, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const body = (await res.json().catch(() => ({}))) as T & { code?: string; error?: string };
  if (res.status === 401 && ['session_revoked', 'session_expired', 'device_locked', 'unauthenticated'].includes(body.code ?? '')) {
    window.location.assign('/');
  }
  return { ok: res.ok, status: res.status, body };
}
