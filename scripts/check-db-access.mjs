#!/usr/bin/env node
// npm run check:db-access (06b DH-12).
import path from 'path';
import { fileURLToPath } from 'url';
import { checkDbAccess } from './lib/check-db-access.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = checkDbAccess(root);
for (const p of problems) console.error(`check:db-access: ${p}`);
if (problems.length) process.exit(1);
console.log('check:db-access: ok');
