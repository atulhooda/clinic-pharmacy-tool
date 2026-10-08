import { SESSION_COOKIE } from '../auth/token';

/** 06a §3.4: httpOnly, sameSite=lax, path=/, `Secure` in production. */
function secure(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === '1';
}

export function secureFlag(): string {
  return secure() ? '; Secure' : '';
}

export function readCookie(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionCookie(token: string, expires: Date): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Expires=${expires.toUTCString()}${secure() ? '; Secure' : ''}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure() ? '; Secure' : ''}`;
}

/** 06a §2.4: the non-secret cookie that remembers which organisation's sign-in link was used. */
export const ORG_COOKIE = 'pharm_org';
export function orgCookie(slug: string): string {
  return `${ORG_COOKIE}=${encodeURIComponent(slug)}; Path=/; SameSite=Lax; Max-Age=${400 * 24 * 3600}${secureFlag()}`;
}
