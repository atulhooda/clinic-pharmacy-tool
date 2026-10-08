#!/usr/bin/env node
// npm test: start real Postgres, prepare the test database with the real bootstrap and
// runner, run every test/**/*.test.ts with node:test (through tsx), then clean up.
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer, prepareDatabase, dropDatabases } from './lib/pg-harness.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function testFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...testFiles(p));
    else if (e.name.endsWith('.test.ts')) out.push(p);
  }
  return out.sort();
}

const runId = crypto.randomBytes(4).toString('hex');
const password = crypto.randomBytes(16).toString('hex');
const prefix = `pt_${runId}_`;
const filter = process.argv.slice(2);

const server = await startServer();
let code = 1;
try {
  const main = await prepareDatabase(server.url, `${prefix}main`, { password });
  const files = testFiles(path.join(ROOT, 'test')).filter((f) => filter.length === 0 || filter.some((x) => f.includes(x)));
  code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-concurrency=1', ...files], {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        TEST_PG_SERVER_URL: server.url,
        TEST_ROLE_PASSWORD: password,
        TEST_DB_PREFIX: prefix,
        TEST_DB_URLS: JSON.stringify(main.urls),
        DATABASE_URL: main.urls.app,
        MIGRATION_DATABASE_URL: main.urls.migrator,
        SELF_CHECK_TTL_MS: '0',
      },
    });
    child.on('exit', (c) => resolve(c ?? 1));
  });
} finally {
  await dropDatabases(server.url, prefix).catch(() => {});
  await server.stop();
}
process.exit(code);
