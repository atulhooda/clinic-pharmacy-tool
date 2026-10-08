import { Pool, types } from 'pg';

/**
 * 06a §5, D-15: node-postgres returns int8 as a string ("100" + "200" = "100200").
 * One global parser turns it into a number and throws unless it is a safe integer.
 * NUMERIC stays a string on purpose: quantities are parsed as integer milli-units.
 */
export function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError('int8 value is outside the safe integer range');
  return n;
}
types.setTypeParser(types.builtins.INT8, parseInt8);

// One shared pool per process (Ritu Desk convention: one long-lived container, max 8).
// globalThis-guarded so `next dev` hot reload does not open a new pool each time.
const g = globalThis as unknown as { __pharmacyPool?: Pool };

export function getPool(): Pool {
  if (!g.__pharmacyPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    g.__pharmacyPool = new Pool({ connectionString, max: 8, idleTimeoutMillis: 30_000, application_name: 'pharmacy-app' });
  }
  return g.__pharmacyPool;
}

/** Tests only: point the app at a pool built by the harness. */
export function setPoolForTests(pool: Pool | undefined): void {
  g.__pharmacyPool = pool;
}
