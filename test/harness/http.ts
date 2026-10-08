// Calls Next route handlers in-process with a real Request: the same code path a browser hits,
// against the real database, with no test-only identity seam (06b DH-15).
import { randomUUID } from 'crypto';
import { POST as signInRoute } from '../../app/api/auth/sign-in/route';

type Handler = (req: Request, ctx: never) => Promise<Response>;

export interface CallResult {
  status: number;
  body: Record<string, any>;
  headers: Headers;
  /** The first Set-Cookie header (PR 2 tests); all of them are in setCookies. */
  setCookie: string | null;
  setCookies: string[];
}

export async function call(
  handler: unknown,
  opts: { method?: string; path?: string; body?: unknown; cookie?: string; ip?: string; headers?: Record<string, string>; params?: Record<string, string>;
          /** Leave out the Idempotency-Key a browser sends on every write (06b DK-01, DK-07). */
          noIdempotencyKey?: boolean } = {},
): Promise<CallResult> {
  const headers = new Headers(opts.headers);
  const multipart = opts.body instanceof FormData;
  if (opts.body !== undefined && !multipart) headers.set('content-type', 'application/json');
  const method = (opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')).toUpperCase();
  // Like the app's client: a fresh key per write unless the test sends its own (06a §12.2).
  if (method !== 'GET' && !opts.noIdempotencyKey && !headers.has('idempotency-key')) headers.set('idempotency-key', randomUUID());
  if (opts.cookie) headers.set('cookie', opts.cookie);
  headers.set('x-real-ip', opts.ip ?? `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.1`);
  const req = new Request(`http://localhost${opts.path ?? '/api/x'}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : typeof opts.body === 'string' || multipart ? (opts.body as BodyInit) : JSON.stringify(opts.body),
  });
  const res = await (handler as Handler)(req, (opts.params ? { params: opts.params } : undefined) as never);
  const text = await res.text();
  let body: Record<string, any> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  const setCookies = res.headers.getSetCookie();
  return { status: res.status, body, headers: res.headers, setCookie: setCookies[0] ?? null, setCookies };
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

/**
 * A browser: a cookie jar that sends its cookies on every call and applies every Set-Cookie,
 * like a real one (06b §3 `as(handle, {device})`). Clone it to model a second tab that kept an
 * old cookie.
 */
export class Browser {
  jar = new Map<string, string>();
  constructor(readonly ip = uniqueIp()) {}

  cookieHeader(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async call(handler: unknown, opts: { method?: string; path?: string; body?: unknown; headers?: Record<string, string>; params?: Record<string, string>; noIdempotencyKey?: boolean } = {}): Promise<CallResult> {
    const r = await call(handler, { ...opts, cookie: this.cookieHeader() || undefined, ip: this.ip });
    for (const c of r.setCookies) {
      const [pair, ...attrs] = c.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (!value || attrs.some((a) => /^\s*max-age=0\s*$/i.test(a))) this.jar.delete(name);
      else this.jar.set(name, value);
    }
    return r;
  }

  clone(): Browser {
    const b = new Browser(this.ip);
    b.jar = new Map(this.jar);
    return b;
  }

  async signIn(orgSlug: string, login: string, password: string): Promise<CallResult> {
    return this.call(signInRoute, { body: { orgSlug, login, password }, path: '/api/auth/sign-in' });
  }
}
