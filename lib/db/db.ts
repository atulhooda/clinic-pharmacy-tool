import type { ClientBase, Pool } from 'pg';

/**
 * The only query surface outside lib/db (06b DH-12: `.query(` appears nowhere else).
 * Every tenant query reaches it through withTenant() (06a §2.3).
 */
export interface Db {
  rows<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}

export function wrap(client: ClientBase | Pool): Db {
  return {
    async rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      const result = await client.query(sql, params as unknown[]);
      return result.rows as T[];
    },
  };
}
