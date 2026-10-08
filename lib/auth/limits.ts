/**
 * 06a §3.8: failed sign-ins per client IP, 20 per 15 minutes (a clinic's staff share one
 * NAT address). Kept in memory: one web replica (§1.3). It moves to the database before a
 * second replica is added.
 */
const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 20;
const failures = new Map<string, number[]>();

function recent(ip: string, now: Date): number[] {
  const list = (failures.get(ip) ?? []).filter((t) => now.getTime() - t < WINDOW_MS);
  failures.set(ip, list);
  return list;
}

/** Seconds until the IP may try again, or 0 if it is not limited. */
export function ipRetryAfter(ip: string, now: Date): number {
  const list = recent(ip, now);
  if (list.length < MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((list[0] + WINDOW_MS - now.getTime()) / 1000));
}

export function recordIpFailure(ip: string, now: Date): void {
  recent(ip, now).push(now.getTime());
}

/**
 * The client address. On Railway, X-Real-IP is set by the edge proxy and cannot be set by
 * the client (re-check this if a CDN is ever put in front). Locally there is no proxy.
 */
export function clientIp(req: Request): string {
  return req.headers.get('x-real-ip')?.trim() || 'local';
}
