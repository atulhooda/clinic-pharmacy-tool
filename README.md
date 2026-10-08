# clinic-pharmacy-tool

A standalone, multi-tenant pharmacy and stock app for clinics. The design is **Spec 06** in [`docs/specs/`](docs/specs/):
- [06](docs/specs/06-dispensary-ledger.md): decisions and milestones;
- [06a](docs/specs/06a-dispensary-ledger.design.md): the design;
- [06b](docs/specs/06b-dispensary-ledger.acceptance.md): the acceptance tests.

**Status:** Milestone 1, PR 5 (the catalogue: the minimal medicine master, dispensary and premises settings, locations, items and pack units, suppliers). No stock movements yet: the ledger is PR 7.

## Requirements

- Node 18.18 or newer.
- Postgres 15 or newer.
  - **Tests** start a throwaway server from the local binaries (`brew install postgresql@16`; or set `PG_BIN`), or use `TEST_PG_SUPERUSER_URL`. Docker is not needed.

## Check everything

```sh
npm install
npm run gate      # migration rules, db-access rule, the palette class lint, typecheck, and the full test suite on real Postgres
npm test -- rls   # only the test files whose path contains "rls"
```

## Run locally

1. **Create a database** and, as a Postgres superuser, run the role bootstrap once:
   ```sh
   createdb pharmacy
   psql -d pharmacy -f ops/bootstrap-roles.sql
   psql -d pharmacy -c "ALTER ROLE pharmacy_migrator PASSWORD '…'" -c "ALTER ROLE pharmacy_app PASSWORD '…'" \
                    -c "ALTER ROLE pharmacy_ops PASSWORD '…'" -c "ALTER ROLE pharmacy_curator PASSWORD '…'"
   ```
2. **Configure.** Copy `.env.example` to `.env.local`, fill in the URLs, a `SESSION_SECRET` and `PIN_PEPPERS`, and export them in your shell.
3. **Migrate and start:**
   ```sh
   npm run db:migrate   # as pharmacy_migrator; exits non-zero on any error
   npm run dev          # the app connects as pharmacy_app
   curl localhost:3000/api/health   # {"ok":true,"schemaVerified":true}
   ```
4. **Create an organisation and its owner** with the founder CLI (06a §3.10). It connects as `pharmacy_ops` and prints the owner's one-time password once:
   ```sh
   OPS_DATABASE_URL=… npx tsx scripts/create-org.ts --slug my-clinic --name "My Clinic" \
     --premises-name Main --address "1 Road, City" --state-code 24 --owner-name "Owner Name" --owner-login owner
   ```
   Then open `localhost:3000/my-clinic/sign-in`. The first sign-in goes straight to the password change.
5. **Load the medicine master** (once per database, and after the seed in `data/master/` changes). It runs as `pharmacy_curator`; see `data/master/SOURCES.md` for what the seed is and is not:
   ```sh
   CURATOR_DATABASE_URL=… node scripts/load-master.cjs
   ```
   Then **Stock → Dispensary setup** sets up the dispensary and each premises' dispensing mode.

**Settings** (`/settings`): the owner manages the organisation's security settings, premises, staff (a new person gets a one-time password, shown once), roles and grant overrides, trusted PCs and the audit log. Every change that matters asks for the owner's signing PIN.

**A shared front-desk PC.** The owner opens Settings → Trusted PCs on that PC and trusts it (confirmed with their signing PIN). After that, each person signs in once a day on it; "Switch person" locks it, and the lock screen switches between the people signed in with their switch PIN. It also locks itself after 3 minutes without input.

**Rotating the PIN pepper** (06a §3.12): add `v<n+1>:…` to `PIN_PEPPERS` and deploy; PINs move to it as people use them. Later, retire the old version with `MIGRATION_DATABASE_URL=… npx tsx scripts/retire-pepper.ts --version <n>`, then remove it from `PIN_PEPPERS`.

**How it fails safe:**
- `npm start` runs the migrations and a configuration check first (`prestart`), so a failed migration or a missing or wrong `PIN_PEPPERS` stops the start.
- If the database is not in a verified state (wrong role, RLS off, a guard missing, migrations differing from the build), every API route answers `503 SCHEMA_UNVERIFIED`.
