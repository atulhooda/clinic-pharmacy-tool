import type { ClientBase, Pool } from 'pg';

/**
 * The only query surface outside lib/db (06b DH-12: `.query(` appears nowhere else).
 * Every tenant query reaches it through withTenant() (06a §2.3).
 */
export interface Db {
  rows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

type Listener = (sql: string) => void;
let listener: Listener | null = null;

/** Tests only: observe the SQL that goes through Db.rows (06b DN-12 counts the guard's lookups). */
export function setQueryListener(next: Listener | null): void {
  listener = next;
}

export function wrap(client: ClientBase | Pool): Db {
  return {
    async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      listener?.(sql);
      const result = await client.query(sql, params as unknown[]);
      return result.rows as T[];
    },
  };
}
