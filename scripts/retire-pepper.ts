// Pepper rotation, step 4 (06a §3.12): retire an old PIN pepper version.
//
//   MIGRATION_DATABASE_URL=… npx tsx scripts/retire-pepper.ts --version 1
//
// Clears every PIN hash made with that version (those people set a new PIN after their next
// full sign-in) and audits it per organisation. Afterwards remove v<version> from PIN_PEPPERS
// and deploy. Prints counts only.
import pg from 'pg';
import { retirePepperVersion } from '../lib/db/pepper-retire';

async function main() {
  const i = process.argv.indexOf('--version');
  const version = Number(i > 0 ? process.argv[i + 1] : NaN);
  if (!Number.isInteger(version)) throw new Error('usage: retire-pepper.ts --version <n>');
  const url = process.env.MIGRATION_DATABASE_URL;
  if (!url) throw new Error('MIGRATION_DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url, max: 1, application_name: 'pharmacy-retire-pepper' });
  try {
    const r = await retirePepperVersion(pool, version);
    console.log(`Retired pepper v${version}: cleared ${r.cleared} PIN hash(es) in ${r.orgs} organisation(s).`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`retire-pepper FAILED: ${(err as { code?: string }).code ?? ''} ${(err as Error).message}`);
  process.exit(1);
});
