export interface MigrationFile {
  version: number;
  name: string;
  file: string;
  sql: string;
  sha256: string;
}
export function listMigrations(dir: string): MigrationFile[];
export function defaultMigrationsDir(): string;
export function sha256(text: string): string;
