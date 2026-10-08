// Founder CLI (06a §3.10): create an organisation, its first premises, its built-in roles and
// its first owner. Runs as pharmacy_ops through OPS_DATABASE_URL.
//
//   OPS_DATABASE_URL=… npx tsx scripts/create-org.ts --slug my-clinic --name "My Clinic" \
//     --premises-name "Main" --address "1 Road, City" --state-code 24 \
//     --owner-name "Owner Name" --owner-login owner [--owner-phone +919800000000] [--gstin …]
//
// It prints the owner's one-time password ONCE, to this terminal only. It is never stored in
// clear, logged or audited; the owner must change it at first sign-in.
import pg from 'pg';
import { createOrganisation } from '../lib/db/create-org';

function arg(name: string, required = true): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  const v = i > 0 ? process.argv[i + 1] : undefined;
  if (required && !v) {
    console.error(`missing --${name}`);
    process.exit(2);
  }
  return v;
}

async function main() {
  const url = process.env.OPS_DATABASE_URL;
  if (!url) throw new Error('OPS_DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url, max: 1, application_name: 'pharmacy-create-org' });
  try {
    const r = await createOrganisation(pool, {
      slug: arg('slug')!,
      displayName: arg('name')!,
      premises: { name: arg('premises-name')!, address: arg('address')!, stateCode: arg('state-code')!, gstin: arg('gstin', false) },
      owner: { name: arg('owner-name')!, login: arg('owner-login')!, phoneE164: arg('owner-phone', false) },
    });
    console.log(`Created organisation ${r.orgId} with premises ${r.premisesId}.`);
    console.log(`Owner's one-time password (shown once; they must change it at first sign-in): ${r.oneTimePassword}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`create-org FAILED: ${(err as { code?: string }).code ?? ''} ${(err as Error).message}`);
  process.exit(1);
});
