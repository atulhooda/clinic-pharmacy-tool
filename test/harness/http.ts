// Calls Next route handlers in-process with a real Request: the same code path a browser hits,
// against the real database, with no test-only identity seam (06b DH-15).
import { randomUUID } from 'crypto';
import { POST as signInRoute } from '../../app/api/auth/sign-in/route';

type Handler = (req: Request, ctx: never) => Promise<Response>;

export interface CallResult {
  status: number;
  body: Record<string, any>;
  headers: Headers;
  setCookie: string | null;
}

export async function call(
  handler: unknown,
  opts: { method?: string; path?: string; body?: unknown; cookie?: string; ip?: string; headers?: Record<string, string> } = {},
): Promise<CallResult> {
  const headers = new Headers(opts.headers);
  if (opts.body !== undefined) headers.set('content-type', 'application/json');
  if (opts.cookie) headers.set('cookie', opts.cookie);
  headers.set('x-real-ip', opts.ip ?? `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.1`);
  const req = new Request(`http://localhost${opts.path ?? '/api/x'}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
  const res = await (handler as Handler)(req, undefined as never);
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body, headers: res.headers, setCookie: res.headers.get('set-cookie') };
}

/** The "name=value" part of a Set-Cookie header, ready to send back. */
export function cookieOf(setCookie: string | null): string {
  if (!setCookie) throw new Error('no Set-Cookie');
  return setCookie.split(';')[0];
}

/** Sign in through A-02 and return the session cookie to send. */
export async function signIn(orgSlug: string, login: string, password: string, ip = `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`): Promise<string> {
  const r = await call(signInRoute, { body: { orgSlug, login, password }, ip, path: '/api/auth/sign-in' });
  if (r.status !== 200) throw new Error(`sign-in failed: ${r.status} ${r.body.code}`);
  return cookieOf(r.setCookie);
}

export const uniqueIp = () => `10.${randomUUID().slice(0, 2).replace(/[^0-9]/g, '1')}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
