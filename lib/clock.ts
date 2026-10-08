/**
 * The injectable clock (06a §5). Every server-side time decision reads it, so tests can pin
 * time (06b frozenClock). Database timestamps that matter (session creation, audit time)
 * are written from it explicitly rather than from the database's now().
 */
let frozen: number | null = null;

export function now(): Date {
  return new Date(frozen ?? Date.now());
}

/** Tests only: pin the clock (or pass null to release it). */
export function setClockForTests(at: Date | null): void {
  frozen = at ? at.getTime() : null;
}

/** The IST business date (`YYYY-MM-DD`) of an instant (06a §5; Asia/Kolkata has no DST). */
export function istDate(at: Date): string {
  return new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** Today in IST, from the injectable clock. */
export const todayIst = (): string => istDate(now());

/** `YYYY-MM-DD` plus n days. */
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
