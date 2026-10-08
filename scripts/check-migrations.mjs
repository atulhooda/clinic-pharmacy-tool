#!/usr/bin/env node
// npm run check:migrations: static migration rules (06b DMG-08, DMG-12).
import path from 'path';
import { fileURLToPath } from 'url';
import { checkMigrationsDir } from './lib/check-migrations.mjs';

const dir = process.env.MIGRATIONS_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const problems = checkMigrationsDir(dir);
for (const p of problems) console.error(`check:migrations: ${p}`);
if (problems.length) process.exit(1);
console.log('check:migrations: ok');
