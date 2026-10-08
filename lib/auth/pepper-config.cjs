// PIN_PEPPERS parsing (06a §3.12). Shared by the app (lib/auth/pins.ts, the self-check) and the
// pre-start check (scripts/check-startup.cjs), so both apply the same rules. Every message names
// the failed check, never the value (06b DPN-17).
'use strict';

const ENTRY = /^v([1-9][0-9]{0,2}):([A-Za-z0-9+/_-]+={0,2})$/;

/**
 * @param {string | undefined} raw  e.g. "v1:<base64 of 32+ bytes>,v2:<…>"
 * @returns {{ok: true, peppers: Map<number, Buffer>, current: number} | {ok: false, check: string}}
 */
function parsePeppers(raw) {
  if (!raw || !raw.trim()) return { ok: false, check: 'PIN_PEPPERS is missing' };
  const peppers = new Map();
  for (const part of raw.split(',')) {
    const m = ENTRY.exec(part.trim());
    if (!m) return { ok: false, check: 'PIN_PEPPERS is malformed (expected comma-separated v<n>:<base64>)' };
    const version = Number(m[1]);
    if (peppers.has(version)) return { ok: false, check: `PIN_PEPPERS lists version ${version} twice` };
    const key = Buffer.from(m[2], 'base64');
    if (key.length < 32) return { ok: false, check: `PIN_PEPPERS version ${version} is shorter than 32 bytes` };
    peppers.set(version, key);
  }
  return { ok: true, peppers, current: Math.max(...peppers.keys()) };
}

/**
 * Pepper versions that stored hashes use but PIN_PEPPERS lacks.
 * @param {{version: number}[]} inUse  rows of pin_pepper_census with hashes > 0
 * @param {Map<number, Buffer>} peppers
 * @returns {number[]}
 */
function missingVersions(inUse, peppers) {
  return [...new Set(inUse.map((r) => Number(r.version)))].filter((v) => !peppers.has(v)).sort((a, b) => a - b);
}

/** The census query both checks run (06a §3.12, R6-14). */
const CENSUS_SQL = 'SELECT DISTINCT version FROM pin_pepper_census WHERE hashes > 0 ORDER BY version';

module.exports = { parsePeppers, missingVersions, CENSUS_SQL };
