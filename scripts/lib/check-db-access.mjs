// 06b DH-12 (and part of DH-04): app code reaches the database only through lib/db,
// and never parses numbers with parseFloat.
import fs from 'fs';
import path from 'path';

const SCAN = ['app', 'lib'];
const ALLOWED_QUERY_DIR = path.join('lib', 'db') + path.sep;
const EXT = /\.(ts|tsx|js|cjs|mjs)$/;

function* walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (EXT.test(e.name)) yield p;
  }
}

/** @returns {string[]} problems as "file:line: message" */
export function checkDbAccess(root) {
  const problems = [];
  for (const top of SCAN) {
    for (const file of walk(path.join(root, top))) {
      const rel = path.relative(root, file);
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (/\.query\s*\(/.test(line) && !rel.startsWith(ALLOWED_QUERY_DIR)) {
          problems.push(`${rel}:${i + 1}: .query( outside lib/db; use withTenant() and the Db interface`);
        }
        if (/\bparseFloat\s*\(/.test(line)) problems.push(`${rel}:${i + 1}: parseFloat is forbidden (06a §5: integers only)`);
      });
    }
  }
  return problems;
}
