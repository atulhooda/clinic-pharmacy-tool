/**
 * 06a §3.4: a session ends at the earlier of 16 hours after sign-in and the next
 * day_reset_time_ist (default 04:00 IST), so everyone signs in fully once per working day.
 * Asia/Kolkata has no daylight saving: IST is always UTC+05:30.
 */
const IST_OFFSET_MS = 330 * 60 * 1000;
const HOUR = 3600 * 1000;

export function sessionExpiry(createdAt: Date, dayResetTimeIst: string): Date {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(dayResetTimeIst);
  if (!m) throw new Error('bad day_reset_time_ist');
  const created = createdAt.getTime();
  const ist = new Date(created + IST_OFFSET_MS);
  let reset = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), +m[1], +m[2], +(m[3] ?? 0)) - IST_OFFSET_MS;
  if (reset <= created) reset += 24 * HOUR;
  return new Date(Math.min(created + 16 * HOUR, reset));
}
