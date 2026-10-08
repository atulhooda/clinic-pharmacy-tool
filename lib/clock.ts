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
