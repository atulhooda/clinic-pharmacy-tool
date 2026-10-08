// Reads migrations/NNN_name.sql. Shared by the runner (scripts/migrate.cjs) and the
// app's startup self-check (lib/db/selfcheck.ts), so both see the same files and checksums.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NAME_RE = /^(\d{3})_([a-z0-9_]+)\.sql$/;

/**
 * @param {string} dir
 * @returns {{version: number, name: string, file: string, sql: string, sha256: string}[]}
 */
function listMigrations(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const out = files.map((file) => {
    const m = NAME_RE.exec(file);
    if (!m) throw new Error(`bad migration file name: ${file} (expected NNN_name.sql, lower-case)`);
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    return { version: Number(m[1]), name: m[2], file, sql, sha256: sha256(sql) };
  });
  out.forEach((f, i) => {
    if (f.version !== i + 1) {
      throw new Error(`migrations must be numbered 001, 002, … with no gaps or duplicates; found ${f.file} at position ${i + 1}`);
    }
  });
  return out;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function defaultMigrationsDir() {
  return process.env.MIGRATIONS_DIR || path.join(__dirname, '..', '..', 'migrations');
}

module.exports = { listMigrations, defaultMigrationsDir, sha256 };
