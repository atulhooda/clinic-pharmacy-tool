import { HttpError } from '../http/errors';
import type { Session } from '../auth/guard';

/**
 * 06a §4.4 (D-17, MR-19): stock reads and operations are restricted to the premises in the
 * caller's membership (the owner: all). Anything else is 404, identical to a premises that
 * does not exist.
 */
export function inScope(s: Session, premisesId: string): boolean {
  return s.premises.some((p) => p.id === premisesId);
}

export function requirePremises(s: Session, premisesId: string): void {
  if (!inScope(s, premisesId)) throw new HttpError(404, 'PREMISES_NOT_FOUND', 'No such premises.');
}

/** A CHECK violation becomes 422 naming the rule (the constraint), never the value. */
export function checkViolation(err: unknown): never {
  const e = err as { code?: string; constraint?: string };
  if (e.code === '23514') throw new HttpError(422, 'FIELD_INVALID', 'A value is out of range.', { rule: e.constraint });
  throw err;
}

export const isoDate = /^\d{4}-\d{2}-\d{2}$/;
