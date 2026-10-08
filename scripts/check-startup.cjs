#!/usr/bin/env node
// The pre-start configuration check (06a §3.12), run by `npm start` after the migrations.
// The app refuses to start if PIN_PEPPERS is missing, malformed or short, or lacks a pepper
// version that stored PIN hashes use (read from the global census; no hash leaves the
// database). Messages name the failed check, never a value (06b DPN-17).
'use strict';
const pg = require('pg');
const { parsePeppers, missingVersions, CENSUS_SQL } = require('../lib/auth/pepper-config.cjs');

function fail(check) {
  console.error(`[startup] FAILED: ${check}`);
  process.exit(1);
}

async function main() {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) fail('SESSION_SECRET is missing or shorter than 32 characters');
  const p = parsePeppers(process.env.PIN_PEPPERS);
  if (!p.ok) fail(p.check);
  if (!process.env.DATABASE_URL) fail('DATABASE_URL is not set');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, application_name: 'pharmacy-startup-check' });
  await client.connect();
  try {
    const missing = missingVersions((await client.query(CENSUS_SQL)).rows, p.peppers);
    if (missing.length) fail(`stored PIN hashes use pepper version ${missing.join(', ')}, which PIN_PEPPERS lacks`);
  } finally {
    await client.end();
  }
  console.log('[startup] configuration ok');
}

main().catch((err) => fail(`could not run (${err.code ?? err.name})`));
