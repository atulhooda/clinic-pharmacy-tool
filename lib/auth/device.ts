import { SignJWT, jwtVerify } from 'jose';
import { derivedKey } from './keys';
import { readCookie, secureFlag } from '../http/cookies';

/**
 * The trusted-device cookie (06a §3.5): an HS256 JWT {v: 1, org, did}, signed with a key
 * derived from SESSION_SECRET. It names the device; the devices row decides whether it is
 * still trusted. Browsers cap cookie lifetime at 400 days, so it is renewed on use.
 */
export const DEVICE_COOKIE = 'pharm_device';
const MAX_AGE_S = 400 * 24 * 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface DeviceClaim {
  org: string;
  deviceId: string;
  token: string;
}

export async function signDeviceToken(org: string, deviceId: string): Promise<string> {
  return new SignJWT({ v: 1, org, did: deviceId }).setProtectedHeader({ alg: 'HS256' }).sign(derivedKey('pharm/device-cookie/v1'));
}

/** The claim, or null for a missing, forged or malformed cookie (which is simply ignored). */
export async function readDeviceToken(token: string | undefined): Promise<DeviceClaim | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, derivedKey('pharm/device-cookie/v1'), { algorithms: ['HS256'] });
    const { v, org, did } = payload as { v?: unknown; org?: unknown; did?: unknown };
    if (v !== 1 || typeof org !== 'string' || typeof did !== 'string' || !UUID.test(org) || !UUID.test(did)) return null;
    return { org, deviceId: did, token };
  } catch {
    return null;
  }
}

export function deviceFromRequest(req: Request): Promise<DeviceClaim | null> {
  return readDeviceToken(readCookie(req.headers.get('cookie'), DEVICE_COOKIE));
}

export function deviceCookie(token: string): string {
  return `${DEVICE_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE_S}${secureFlag()}`;
}

export function clearDeviceCookie(): string {
  return `${DEVICE_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureFlag()}`;
}
