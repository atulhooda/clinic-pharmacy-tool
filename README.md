# clinic-pharmacy-tool

A standalone, multi-tenant pharmacy and stock app for clinics. The design is **Spec 06** in [`docs/specs/`](docs/specs/):
- [06](docs/specs/06-dispensary-ledger.md): decisions and milestones;
- [06a](docs/specs/06a-dispensary-ledger.design.md): the design;
- [06b](docs/specs/06b-dispensary-ledger.acceptance.md): the acceptance tests.

**Status:** Milestone 1, PR 2 (password sign-in, roles, the audit log, the sign-in screen). No stock screens yet.

## Requirements

- Node 18.18 or newer.
- Postgres 15 or newer.
  - **Tests** start a throwaway server from the local binaries (`brew install postgresql@16`; or set `PG_BIN`), or use `TEST_PG_SUPERUSER_URL`. Docker is not needed.

## Check everything

```sh
npm install
npm run gate      # migration rules, db-access rule, typecheck, and the full test suite on real Postgres
npm test -- rls   # only the test files whose path contains "rls"
```

## Run locally

1. **Create a database** and, as a Postgres superuser, run the role bootstrap once:
   ```sh
   createdb pharmacy
   psql -d pharmacy -f ops/bootstrap-roles.sql
   psql -d pharmacy -c "ALTER ROLE pharmacy_migrator PASSWORD '…'" -c "ALTER ROLE pharmacy_app PASSWORD '…'" \
                    -c "ALTER ROLE pharmacy_ops PASSWORD '…'"
   ```
2. **Configure.** Copy `.env.example` to `.env.local`, fill in the URLs and a `SESSION_SECRET`, and export them in your shell.
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

**How it fails safe:**
- `npm start` runs the migrations first (`prestart`), so a failed migration stops the start.
- If the database is not in a verified state (wrong role, RLS off, a guard missing, migrations differing from the build), every API route answers `503 SCHEMA_UNVERIFIED`.
