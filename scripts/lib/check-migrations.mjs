// Static checks over migrations/ (06b DMG-08, DMG-12; 06a §18, R6-8).
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { listMigrations } = require('../../lib/db/migration-files.cjs');

/** Remove comments, string literals and dollar-quoted bodies, so keywords inside them don't count. */
export function stripSql(sql) {
  return sql
    .replace(/\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

const IDENT = String.raw`(?:public\.)?"?([a-z_][a-z0-9_]*)"?`;

/** @returns {string[]} problems (empty = pass) */
export function checkMigrationsDir(dir) {
  let files;
  try {
    files = listMigrations(dir); // DMG-12: names and contiguous numbering
  } catch (err) {
    return [err.message];
  }
  const problems = [];
  const createdIn = new Map();
  for (const f of files) {
    const sql = stripSql(f.sql);
    for (const m of sql.matchAll(new RegExp(String.raw`CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENT}`, 'gi'))) {
      if (!createdIn.has(m[1].toLowerCase())) createdIn.set(m[1].toLowerCase(), f.version);
    }
    for (const raw of sql.split(';')) {
      const stmt = raw.trim();
      if (/^(BEGIN|COMMIT|ROLLBACK|END|START\s+TRANSACTION)\b/i.test(stmt)) {
        problems.push(`${f.file}: contains transaction control (${stmt.split(/\s/)[0]}); the runner wraps each file in one transaction`);
      }
      const alter = new RegExp(String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?${IDENT}\s+([\s\S]*)$`, 'i').exec(stmt);
      if (alter && createdIn.get(alter[1].toLowerCase()) !== f.version
          && /\b(DROP|RENAME|TYPE|DISABLE)\b|\bSET\s+DATA\b|\bNO\s+FORCE\b/i.test(alter[2])) {
        problems.push(`${f.file}: ALTER TABLE ${alter[1]} may only add to a table an earlier migration created (R6-8): "${alter[2].replace(/\s+/g, ' ').slice(0, 80)}"`);
      }
      const drop = new RegExp(String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?${IDENT}`, 'i').exec(stmt);
      if (drop && createdIn.get(drop[1].toLowerCase()) !== f.version) {
        problems.push(`${f.file}: drops table ${drop[1]}, which an earlier migration created`);
      }
    }
  }
  return problems;
}
