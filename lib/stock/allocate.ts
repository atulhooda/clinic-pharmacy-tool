/**
 * Allocation (06a §8): a pure function. No I/O and no clock read, so the same inputs always
 * give the same result (06b DP-04).
 *
 * 1. Eligible: `available > 0` and `expiryDate ≥ asOf` (the IST date of occurred_at); a batch is
 *    dispensable through the end of its expiry date (§11.3).
 * 2. Order by (expiryDate, batchSeq, batchId): earliest expiry, then earliest receipt, then a
 *    stable id.
 * 3. Greedy, possibly across batches.
 * 4. Short: `Insufficient` with both totals, so the screen can say "15 more on the shelf are expired".
 * 5. An untracked item has one pseudo-candidate (batchId null, no expiry).
 * 6. Several lines for one item allocate in line order against a running snapshot (allocateLines).
 *
 * The caller passes candidates of ONE non-quarantine location (L-20): quarantined stock is
 * never a candidate.
 */
export interface BatchStock {
  batchId: string | null;
  /** `YYYY-MM-DD`; null only for the untracked pseudo-candidate. */
  expiryDate: string | null;
  batchSeq: number;
  available: number;
}
export interface Allocation {
  batchId: string | null;
  qtyBase: number;
}
export interface Insufficient {
  insufficient: true;
  availableNonExpired: number;
  expiredOnHand: number;
}

const eligible = (c: BatchStock, asOf: string) => c.available > 0 && (c.expiryDate === null || c.expiryDate >= asOf);

function order(a: BatchStock, b: BatchStock): number {
  const ea = a.expiryDate ?? '9999-12-31';
  const eb = b.expiryDate ?? '9999-12-31';
  if (ea !== eb) return ea < eb ? -1 : 1;
  if (a.batchSeq !== b.batchSeq) return a.batchSeq - b.batchSeq;
  const ia = a.batchId ?? '';
  const ib = b.batchId ?? '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

export function allocate(candidates: readonly BatchStock[], qtyBase: number, asOf: string): Allocation[] | Insufficient {
  if (!Number.isSafeInteger(qtyBase) || qtyBase <= 0) throw new RangeError('allocate: qtyBase must be a positive integer');
  const usable = candidates.filter((c) => eligible(c, asOf)).sort(order);
  const availableNonExpired = usable.reduce((n, c) => n + c.available, 0);
  if (availableNonExpired < qtyBase) {
    const expiredOnHand = candidates.filter((c) => c.available > 0 && !eligible(c, asOf)).reduce((n, c) => n + c.available, 0);
    return { insufficient: true, availableNonExpired, expiredOnHand };
  }
  const out: Allocation[] = [];
  let left = qtyBase;
  for (const c of usable) {
    if (left === 0) break;
    const take = Math.min(left, c.available);
    out.push({ batchId: c.batchId, qtyBase: take });
    left -= take;
  }
  return out;
}

/** Rule 6: lines for the same item share one pool, in line order. */
export function allocateLines(candidates: readonly BatchStock[], qtys: readonly number[], asOf: string): (Allocation[] | Insufficient)[] {
  const pool = candidates.map((c) => ({ ...c }));
  return qtys.map((q) => {
    const r = allocate(pool, q, asOf);
    if (!('insufficient' in r)) {
      for (const a of r) {
        const c = pool.find((x) => x.batchId === a.batchId);
        if (c) c.available -= a.qtyBase;
      }
    }
    return r;
  });
}

export const isInsufficient = (r: Allocation[] | Insufficient): r is Insufficient => 'insufficient' in r;
