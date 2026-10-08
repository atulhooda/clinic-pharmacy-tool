# Spec 06a — Clinic Pharmacy Tool: Design

**Status:** **Rev 6 (standalone)**, 2026-10-08. **Milestone 1 is being built** (§19); everything else stays design.
**Written against:** clinic-pharmacy-tool `origin/main` @ `6f5ffb2` (fetched 2026-10-08; README only). Stack conventions from Ritu Desk `origin/main` @ `8bee594` (fetched 2026-10-08; no newer commits).
**History:** Revisions 4–6 were squashed into one commit when this repo's history was cleaned on 2026-10-08; the revision notes say what each changed. Earlier drafts, from when this was planned as a Ritu Desk module, are kept privately. Rev 4 replaced those drafts (D-24).

**Type:** design spec (architecture, identity, data model, invariants, operations, API)
**Index, decisions, open questions:** [06](06-dispensary-ledger.md) · **Acceptance gate:** [06b](06b-dispensary-ledger.acceptance.md)

**Rev 6 changes (founder round 6, D-38 … D-41):**
- **Milestone 1** is defined (06 §5); §18 renumbers the migrations in build order; §19 is the Milestone 1 PR plan.
- Password sign-in only in Milestone 1; phone OTP moves to Milestone 2 (§3.3, §3.9).
- The test harness runs real Postgres from local binaries or a given server (§1.2, R6-6).
- Later milestones may add to earlier tables, never drop or rename (§18, R6-8).

**Rev 5 changes (founder review of Rev 4, D-31 … D-37):**
- **Tenant integrity beyond RLS (D-31, new §2.6).** Postgres does not apply RLS to foreign-key or unique checks, so:
  - every tenant table's primary key is `(org_id, id)`;
  - every FK between tenant tables is composite on `org_id`;
  - every unique constraint includes `org_id`;
  - batches, stock movements, balances, allocations and every other batch-naming row also carry `premises_id` in their FKs, so nothing can draw on another branch's stock.
- **`requires_prescription` is a flag on items, stored as data (D-32).** Starting values: oral isotretinoin, acitretin, every Schedule X item. No drug names in code.
- **The signing PIN also covers backdating past the reason-free lag and stock-count adjustments (D-33).** Only people whose role holds a PIN-gated permission get a signing PIN.
- **PINs are hashed with a pepper kept outside the database (D-34),** with a rotation runbook (new §3.12).
- **Prescription photos (D-35):** compressed in the browser to a few hundred KB; the 2 MB server cap stays; they live in their own table; they move to object storage at **10 GB** in total.
- **Patients (D-36):** phone is not unique; matching is on name + phone; a merge tool records merges and resolves them at read time, never rewriting dispense or ledger rows.
- **Hosting and repo (D-37):** the repo moves to the Engageo GitHub organisation; hosting is its own Railway project, separate from Ritu Desk.

**Rev 4 changes (founder round 4, D-24 … D-30):**
- **A standalone app,** with its own codebase (`clinic-pharmacy-tool`) and its own database. It uses no table, route, library or switch of Ritu Desk.
- **Multi-tenant from the first migration:**
  - organisations and premises;
  - Postgres RLS;
  - the app connects as a non-superuser, non-owner role;
  - one shared database for every organisation.
- **Its own minimal records:** patients, prescribers, and prescriptions (uploaded photos or manual entries).
- **Its own sign-in for a shared front-desk PC:**
  - a daily full sign-in;
  - PIN switching;
  - idle auto-lock;
  - a signing PIN separate from the switch PIN.

  The ideas come from Ritu Desk's Spec 07; none of its code or tables are used.
- **Kept from Rev 3:**
  - the ledger and every DB-enforced invariant;
  - batches, expiry and FEFO;
  - the dispensing mode on the premises;
  - the H1 and purchase registers;
  - the scheduled-drug and backdating rules;
  - the opened-vial design;
  - the WhatsApp boundary.

**How Specs 01–05 (written for claria) carry over:**

| Spec | How it applies |
|---|---|
| 01 | its test style is used for 06b |
| 02 | its real-Postgres harness idea is used, with testcontainers |
| 03 | expand/contract governs every schema change after the first release |
| 04 | "tenant from a verified claim" governs §3 |
| 05 | its ORM guard is not ported: RLS (§2) replaces it |

---

## 0. Principles every section is checked against

1. **The ledger is the truth.** On-hand stock is `Σ stock_movements.qty_delta`. Balances, reports and registers are derived and rebuildable.
2. **Correctness lives in the database.** Postgres constraints, triggers and RLS block:
   - negative stock;
   - edited ledger rows;
   - use of expired stock;
   - cross-tenant references and reads;
   - double posting.

   Service code checks first so it can give good errors; the database is the backstop. That includes the checks RLS does not cover: foreign keys and unique constraints (§2.6).
3. **Organisation = the tenant; premises = the legal unit (D-6).** An organisation (a clinic business) is one business, with one patient list, one catalogue and one staff list. Each premises (for example, a branch in Gujarat and one in Maharashtra) is a location inside it. Dispensing mode, drug licences, registers and state-specific fields attach to the premises.
4. **The tenant comes from verified identity, never from the request.** The organisation comes from a server-signed session or device cookie (§3). No request body or query carries `orgId`.
5. **Integers only:** quantities in base units, money in paise, rates in basis points. No floats in TypeScript, SQL or JSON. Convert only at display and API edges (§5).
6. **UTC stored, IST reasoned.** All business-day logic uses `Asia/Kolkata`.
7. **No model in the loop.**
   - No LLM output feeds stock state, allocation, pricing, compliance, registers or prescription records.
   - A prescription photo is evidence for a human. Its lines are typed by staff; there is no OCR and no extraction.
8. **No clinical decision support:** no dose calculation, no interaction checking, no automatic substitution.
9. **Configuration over code.** Differences between organisations and premises are rows: no `if org_id == …`, and no drug names in code.
10. **Standalone (D-24, D-29).** Nothing here depends on Ritu Desk, its voice server or Ritu Desk's Spec 07. Ideas borrowed from them are restated in full.

---

## 1. The app, its stack and its deployment

### 1.1 Shape

- **One Next.js app** (the `clinic-pharmacy-tool` repo) serves every organisation from one domain. Sign-in, stock, dispensing, registers and administration share one codebase.
- **One Postgres database for all organisations** (D-25), isolated by RLS and database roles (§2). There are no per-organisation or per-branch databases.
- **One scheduled-job service** (§13).
- **Engageo creates organisations;** there is no public sign-up (§3.10).

### 1.2 Stack (D-30: Ritu Desk's stack by default)

One engineer maintains both apps, so the stack is Ritu Desk's unless a row says otherwise and why.

| Concern | Choice | Compared with Ritu Desk |
|---|---|---|
| Framework | Next.js 14 App Router route handlers, TypeScript 5. Versions are pinned to the desk's (`next ^14.2.35`, `react ^18.3.1`, `typescript ^5.6.3`) and upgraded together. | same |
| DB access | raw `pg` (`^8.13`); one shared `Pool` per process (`max: 8`); every query goes through `withTenant()` (§2.3) | same driver and pool. **No Prisma:** the desk carries `@prisma/client` but writes raw SQL, and RLS needs a per-transaction `set_config`, which raw `pg` makes explicit. |
| Migrations | numbered SQL files `migrations/NNN_name.sql`; a small Node runner; a `schema_migrations` table | same pattern. **The runner behaves differently (§18):**<br>• it runs as the migrator role through `MIGRATION_DATABASE_URL`;<br>• it records a checksum per file;<br>• it **fails the deploy** on any error. |
| Validation | hand-written, through a shared `strictBody()` that rejects unknown keys | same (no validation library) |
| Sessions | an HS256 JWT cookie via `jose`; a server-side session row re-read on every request | same idea, written fresh (§3) |
| Password and PIN hashing | Node `crypto.scrypt`: N = 2^15, r = 8, p = 1, 32-byte key, 16-byte salt | same parameters |
| UI | hand-built components; a Tailwind (`^3.4`) custom palette checked by a class lint; SWR polling; en/hi/gu with Latin digits | **Starts from a copy** of the desk's `components/ui` kit and palette, so both apps look and work alike. This repo owns the copy, with no package or runtime link back to the desk. |
| Registers | an HTML print view plus CSV | **Different.** The desk prints prescriptions with a server-side pdfkit + HarfBuzz engine. v1 does not need one: the browser shapes Gujarati and Devanagari names correctly when it prints. A server PDF is Phase 2, if an inspector asks for files. |
| File storage | prescription photos as `BYTEA` in Postgres, in their own table: compressed in the browser, size-capped, magic-byte sniffed, SHA-256 recorded | the same approach as Ritu Desk's uploads. **They move to object storage when the table reaches 10 GB in total** (§6.2, D-35). |
| Tests | `node:test` + `node:assert` (run through `tsx`); a **real Postgres ≥ 15** with the real roles and migrations; `fast-check` | same idea. **The harness starts a throwaway cluster from the local Postgres binaries** (`initdb`/`pg_ctl`, TCP on 127.0.0.1), or uses `TEST_PG_SUPERUSER_URL` when given (CI with a Docker service). Docker is not required (R6-6). |
| Hosting | Railway: one project with the web service, a cron service and Postgres ≥ 15 | same platform, but **its own project**, separate from Ritu Desk (D-37) |
| Messaging | staff OTP through the WhatsApp Cloud API (an Engageo-owned number) and a DLT-registered SMS provider, both over `fetch` | new (the desk has no OTP); no SDK |

Nothing in the table is new technology to the engineer. Each of the three deliberate differences removes work or risk:
- the fail-closed runner;
- no Prisma;
- HTML registers.

### 1.3 Deployment and connection budget

| Process | Connections |
|---|---|
| web (per replica) | pool `max: 8` |
| cron jobs | 2 |
| migration runner, during a deploy | 1 |
| Postgres `superuser_reserved_connections` | 3 |

- **One replica serves every organisation with 14 connections.** Postgres's default `max_connections` of 100 leaves room for about 10 more replicas. Organisations share one pool, so the cost does not grow per organisation.
- **PgBouncer works unchanged if it is ever needed.** The tenant is set per transaction (`set_config(…, true)`, §2.3), so the app runs behind PgBouncer in transaction-pooling mode as is. No per-organisation login roles are needed.
- **A CI check** (`check:connection-budget`) fails if replicas × pool + jobs + runner + reserved exceeds 80 % of `max_connections`.
- **The in-memory rate limits (§3.8) assume one web replica.** They move into the database before a second replica is added.

---

## 2. Tenancy and isolation (D-6, D-8, D-25)

### 2.1 Organisations and premises

| Concept | Table | Meaning |
|---|---|---|
| tenant | `organisations` | The business, e.g. a clinic group: one patient list, one catalogue, one staff list. |
| legal unit | `premises` | A physical location of the organisation, e.g. a branch in Gujarat or one in Maharashtra. Dispensing mode, drug licences, registers, state code and GSTIN attach here. |

- Every tenant table carries `org_id`.
- Branch-level tables also carry `premises_id`, with a composite FK `(org_id, premises_id) → premises (org_id, id)`.
- `medicine_master` is the only global table (§6.3).
- `organisations` is the tenant root, so its policy compares `id` (not `org_id`) with the setting.

### 2.2 Database roles

All roles are `NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`. Only the migrator owns objects.

| Role | Used by | Grants |
|---|---|---|
| `pharmacy_migrator` | the migration runner, through `MIGRATION_DATABASE_URL`; the test harness's resets | owns every table, sequence and function; DDL |
| `pharmacy_app` | the web app, through `DATABASE_URL` | per table, exactly what §18 lists:<br>• never TRUNCATE;<br>• never UPDATE or DELETE on append-only tables;<br>• SELECT only on `medicine_master`;<br>• no INSERT on `organisations` |
| `pharmacy_jobs` | the cron service | what the jobs need; may read the organisation list (§2.4) |
| `pharmacy_ops` | founder CLIs (§3.10): create an organisation and its first owner; recover an owner | INSERT on `organisations`, plus the identity tables those CLIs write |
| `pharmacy_curator` | Engageo's master-data tooling (06 OQ-5) | INSERT/UPDATE on `medicine_master`; SELECT/UPDATE on `master_correction_requests` across tenants (§2.4) |
| `pharmacy_resolver` | **NOLOGIN**; owns one function, `auth_resolve_org()` | SELECT on four columns of `organisations` |

- **How the roles are created:** once per environment, by `ops/bootstrap-roles.sql`, run by the platform superuser (Railway's `postgres`).
- **After that, no service's environment holds a superuser DSN** (06b DS-12).

### 2.3 Row-level security

Every tenant table:

```sql
ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE <t> FORCE  ROW LEVEL SECURITY;        -- applies to the table owner too
CREATE POLICY tenant_isolation ON <t>
  USING      (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);
-- organisations: the same with id in place of org_id
```

- **One way in.** Every query runs inside `withTenant(orgId, fn)`, which:
  - opens a transaction on the shared pool;
  - calls `SELECT set_config('app.org_id', $1, true)`.

  The `true` makes the setting transaction-local: it is cleared at COMMIT or ROLLBACK and can never leak to the next request on a pooled connection. (`SET LOCAL` cannot take a bind parameter.)
- **Fail-closed.** Outside `withTenant` the setting is unset, so `NULLIF(…)` yields NULL and every policy matches **zero rows**; INSERTs fail `WITH CHECK`. Forgetting the tenant returns nothing; it never returns everything.
- **Where `orgId` comes from:** only the verified session (§3.4), a verified device cookie (§3.5), or an organisation resolved by slug before sign-in (§2.4). Never a body or query field: `strictBody()` rejects `orgId`.
- **RLS does not cover foreign-key and unique checks.** §2.6 closes that gap: composite keys, composite FKs, and `org_id` in every unique constraint.
- **No `assert_same_org()` triggers.** Patients, prescribers, prescriptions and staff now live in the same database as the ledger, so every reference is a composite FK. Rev 3 needed the triggers only for Ritu Desk tables.

### 2.4 The only doors past RLS

**Before sign-in, the app needs the organisation, and there is no session yet.** It comes from, in order:
1. a valid trusted-device cookie (§3.5), which names its organisation;
2. otherwise the organisation's sign-in link `/{orgSlug}/sign-in`. The owner shares the link, and the browser remembers the slug in a non-secret `pharm_org` cookie.

**Resolving the slug is the only lookup that crosses tenants.** It goes through one function, owned by the NOLOGIN role `pharmacy_resolver` and backed by a role-targeted policy:

```sql
CREATE POLICY org_directory ON organisations FOR SELECT
  TO pharmacy_resolver, pharmacy_jobs USING (true);

CREATE FUNCTION auth_resolve_org(p_slug text) RETURNS TABLE (id uuid, display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT id, display_name FROM organisations
   WHERE slug = lower(p_slug) AND status = 'ACTIVE'
$$;
ALTER FUNCTION auth_resolve_org(text) OWNER TO pharmacy_resolver;
GRANT EXECUTE ON FUNCTION auth_resolve_org(text) TO pharmacy_app;
```

- **Why a dedicated owner role.** Because RLS is forced, a `SECURITY DEFINER` function owned by the migrator would still see zero rows before sign-in. A NOLOGIN role that can read only four columns of `organisations` is the smallest owner that works.
- **Everything else runs inside `withTenant(thatOrg)`:** finding the login, checking the password, sending an OTP.
- **The cron service** reads the organisation list through the same `org_directory` policy, then processes each organisation inside `withTenant`.
- **Curation** reads correction requests across tenants through two role-targeted policies on `master_correction_requests`, `curation_select` and `curation_update`, for `pharmacy_curator` only. Those rows contain no patient data.
- **The self-check (§2.5) fails on any other policy.**

### 2.5 Startup and readiness self-check

If any check fails, every `/api/*` route except `GET /api/health` returns **503 `SCHEMA_UNVERIFIED`**, sign-in included, and the failing check is logged.

1. **Role:** `pg_roles` for `current_user` shows `rolsuper = false` and `rolbypassrls = false`.
2. **Ownership:** `current_user` owns no table, sequence or function in the schema.
3. **RLS:**
   - every table with `org_id`, and `organisations`, has `relrowsecurity` **and** `relforcerowsecurity`, plus the `tenant_isolation` policy;
   - no table has any other policy except the reviewed list: `org_directory`, `curation_select`, `curation_update`.
4. **Enforcement objects:**
   - the §7.3 triggers;
   - the `on_hand` CHECK;
   - the natural-key UNIQUE;
   - the `stock_reversals` UNIQUE;
   - the append-only triggers on `audit_log` and the history tables.
5. **Migrations:** the applied set in the database equals the files shipped in this build, by name and checksum.

**The runner normally fails the deploy before this check could fire.** The self-check is the second line of defence, e.g. if someone points `DATABASE_URL` at the superuser.

### 2.6 Tenant integrity: what RLS does not cover (D-31)

**Why this section exists.** Postgres applies row-level security to queries, but **not** to the checks behind foreign keys and unique constraints:
- **A foreign-key check sees the parent row whatever the policy says.** With a single-column FK, org A could insert a row pointing at org B's row, as long as it knew the id.
- **A unique index compares against every row in the table.** Without `org_id` in it, one organisation's data could block another's insert, and the error would confirm that the other row exists.

**Rules.** The migration tests (06b DS-18 … 21, DMG-05/06/14) check every one, from the catalog.

1. **Primary keys.** Every tenant table's primary key is **`(org_id, id)`**. No tenant table has a single-column key on `id`. (Rev 4 had `id` as the key, plus `UNIQUE (org_id, id)`.)
2. **Foreign keys.** Every FK from one tenant table to another is composite and starts with `org_id`: `FOREIGN KEY (org_id, x_id) REFERENCES x (org_id, id)`. This includes every actor and `*_by` column (→ `staff_users`), `otp_challenges` and `reauth_grants`.
3. **Branch stock.** Every row that names a batch or a stock location carries **`premises_id`**, and its FKs include it:

   | Row | Key or FK |
   |---|---|
   | `batches` (per premises) | UNIQUE (`org_id`, `premises_id`, `item_id`, `id`) and (`org_id`, `premises_id`, `item_id`, `batch_no`, `expiry_date`) |
   | `stock_locations` | UNIQUE (`org_id`, `premises_id`, `id`) |
   | `stock_movements`, `stock_balances` | (`org_id`, `premises_id`, `location_id`) → `stock_locations`; (`org_id`, `premises_id`, `item_id`, `batch_id`) → `batches` |
   | document headers (GRN, dispense, procedure use, patient return, supplier return, adjustment, import) | UNIQUE (`org_id`, `premises_id`, `id`); (`org_id`, `premises_id`, `location_id`) → `stock_locations` |
   | their lines | (`org_id`, `premises_id`, header id) → the header |
   | `dispense_allocations`, `procedure_use_allocations` | (`org_id`, `premises_id`, line id) → the line; (`org_id`, `premises_id`, `item_id`, `batch_id`) → `batches` |
   | GRN, supplier-return and adjustment lines | (`org_id`, `premises_id`, `item_id`, `batch_id`) → `batches` |
   | `patient_returns` | (`org_id`, `premises_id`, `dispense_id`) → `dispenses` |
   | `opened_containers` | (`org_id`, `premises_id`, `item_id`, `batch_id`) → `batches`; allocations reference containers with `premises_id` too |

   So a document at one premises can never draw on, return into, or write off another premises' batch, whatever the code does (L-26).
4. **Unique constraints.** Every unique constraint and unique index on a tenant table includes `org_id`, and also `premises_id` where the thing is per premises. Rev 4 had a few without it; they now include it:
   - `stock_movements.seq` and `reverses_movement_id`;
   - line numbers per header;
   - location names, the default location and the quarantine location per premises;
   - unit names per item;
   - outbox dedupe keys.
5. **Reviewed exceptions** (06b DMG-14 fails on any other):
   - `organisations`, the tenant root: primary key `id`, UNIQUE `slug`; every tenant table's `FOREIGN KEY (org_id) REFERENCES organisations (id)`.
   - `medicine_master`, the only global table. Tenant rows reference it with a single-column FK (`items.master_id`, `stock_import_rows.matched_master_id`, `master_correction_requests.master_id`). That is safe because the master holds no tenant data.
   - `audit_log`'s staff, session and device ids, which are deliberately not FKs (§6.1).
   - the runner's `schema_migrations`.
6. **Sequence numbers.** The `seq` identity columns come from shared sequences. They are used only for ordering inside the database and **never returned by the API**, because gaps would hint at other organisations' volume.

**Consequence for patient returns.** Batches are per premises, so a return is received **at the premises that dispensed** (409 `RETURN_WRONG_PREMISES`). Receiving it anywhere else would be a stock move between branches, and between states it is inter-state (MR-16).

---

## 3. Identity and sign-in on a shared front-desk PC (D-27)

### 3.1 What the founder asked for, and the design in brief

**The situation.** A clinic's front-desk PC is used by two or three people all day.

**The design:**
- **Daily full sign-in.** Each person signs in fully once a working day, with a password or a phone OTP.
- **PIN switching.** After that, switching person takes a name and a 6-digit **switch PIN** on a "Who's working?" lock screen.
- **Idle auto-lock.** The PC locks itself after 3 minutes without input. The server refuses any request sent after that moment, so nobody can act under the previous person's name.
- **A separate signing PIN.** Consequential actions ask for a 6-digit **signing PIN**, never the switch PIN, because the switch PIN is typed in view of the whole desk all day.

**Ideas borrowed from Ritu Desk** (Spec 07 §6–7 and its Phase 1 staff logins):
- trusted devices, with several open sessions per device;
- the lock screen and a separate switch PIN;
- the idle lock, with the server refusing requests after it;
- per-user PIN limits;
- single-use re-auth grants;
- the scrypt parameters;
- OTP over WhatsApp with a DLT SMS fallback;
- the per-device sign-in counter;
- an append-only audit log with no patient content.

**None of its code or tables is used (D-27).** The desk's auth is built for a different deployment model, and this app is multi-tenant from the first migration.

### 3.2 Staff accounts

- **Organisation.** A staff user belongs to one organisation.
- **Login and phone.** `login` (lower-case) and `phone_e164` are each unique within the organisation. The same phone may exist in two organisations, e.g. a visiting doctor.
- **Role:** one of the organisation's roles (§4.1).
- **Premises:** `staff_premises` rows. `owner` implicitly holds every premises.
- **Credentials,** all scrypt, with the hash shape CHECKed by the DB:
  - `password_hash`, optional when a phone is set;
  - `switch_pin_hash`;
  - `signing_pin_hash`, only for people whose role holds a PIN-gated permission (§3.7).

  PINs are hashed with a pepper held outside the database (§3.12).
- **Prescriber link.** A doctor who prescribes is linked to their prescriber row (`staff_users.prescriber_id`, §6.2). A **prescriber-linked session** in this spec means a session of such a user. It is required for verifying a prescription record and for the lapsed-vial override.
- **Creation.** The owner creates staff (M-05), either:
  - with a one-time password shown once, which must be changed at the first sign-in; or
  - by phone only, so the first sign-in is by OTP.

### 3.3 Full sign-in

Either method creates a session (§3.4). **Milestone 1 ships password sign-in only** (D-39); phone OTP is Milestone 2, once its templates are approved.
- **Password:** `{login, password}`. An unknown login runs a dummy scrypt verify and gets the same 401 `invalid_credentials` in the same time.
- **Phone OTP** (§3.9): `{phone}` → code → session.

**Rules:**
- The organisation comes from §2.4.
- A full sign-in clears a switch-PIN block for that person (§3.8).
- On a trusted device, a full sign-in **does not end anyone else's session** on that device.
- If the same person already has an open session on that device, it is replaced (reason `replaced`).
- Anyone signing in on a trusted device without a switch PIN must set one before doing anything else (403 `switch_pin_required`).

### 3.4 Sessions: one working day

- **Storage.** A server-side row in `sessions`. The cookie `pharm_session` (httpOnly, `secure`, `sameSite=lax`, `path=/`) carries an HS256 JWT `{v: 1, org, sid}`, signed with `SESSION_SECRET`.
- **Daily.** `expires_at` is the earlier of:
  - 16 h after sign-in;
  - the next `day_reset_time_ist` (an org setting, default **04:00 IST**).

  So every person signs in fully at least once per working day.
- **Every request re-reads, in one query** inside `withTenant(claims.org)`:
  - the session row;
  - the user (active? which role?);
  - the role's effective grants (§4.1);
  - the premises memberships;
  - on a trusted device, the device and whose session is active on it.

  So deactivation, a role change, a membership removal and device revocation all take effect on the next request.
- **Untrusted browsers** (a doctor's phone, an owner at home) get one session with the same daily expiry and no PIN switching.
  - Idle timeout is **off by default** (`untrusted_idle_minutes` NULL). This follows the founder's preference that doctors and owners are not timed out mid-day.
  - An organisation can set one.

### 3.5 Trusted devices and the "Who's working?" lock screen

1. **Registering a PC.**
   - The owner, signed in on that PC, opens Settings → Devices → "Trust this PC", names it, picks its premises, and confirms with their signing PIN (purpose `devices.register`).
   - This creates a `devices` row and sets a `pharm_device` cookie holding `{org, deviceId}`. The cookie is httpOnly, `secure`, `sameSite=lax` and signed with a key derived from `SESSION_SECRET`. It is renewed on use, because browsers cap cookie lifetime at 400 days.
2. **Several open sessions per device.** Each person's daily full sign-in on that PC adds a session with `device_id` set.
3. **The lock screen** lists the people with an open, unexpired session on this device: name and role only.
   - Tapping a name and typing **that person's switch PIN** makes their session the active one: `device_state.active_session_id` points to it, and the session cookie is reissued for it. No password is needed.
   - "Someone else" opens the full sign-in.
4. **One active person at a time.** A request carrying a session that is not the device's active session gets **401 `device_locked`**, so a second browser tab still holding the previous person's cookie cannot act.
   - **No write straddles a switch.** A write reads the device's `device_state` row `FOR SHARE` inside its own transaction. A switch or lock updates that row, so it waits for any in-flight write to finish. A write therefore never commits after the person at the PC has changed (06b DC-11).
5. **Bound to its device.** A session created on a device is accepted only with that device's cookie (401 `device_mismatch`).
6. **Revoking a device** (M-11) ends every session on it at the next request.
7. **The device's premises** becomes the default premises on every stock screen used from it. It grants nothing: membership (MR-19) is still checked.
8. **Audit:**
   - audited: `auth.device_registered`, `auth.device_revoked`, `auth.switched {device_id, from_session_id, to_session_id}`;
   - logged only (it happens many times a day): a device lock.

### 3.6 Idle auto-lock

- **When it locks:**
  - after **`device_lock_minutes`** without real input: an org setting, **default 3**, CHECK 1–10;
  - on "Switch person";
  - when the browser closes.
- **What counts as real input:** keyboard, pointer or touch on the page. While there is input, the client sends an activity ping (A-08) at most every 30 s, and every non-GET request counts as input. Background polls (SWR) and prefetches never count, so a dashboard left open does not keep the PC unlocked.
- **The server decides.** On a trusted device, the guard compares `now − sessions.last_input_at` (read **before** it is touched) with the setting. Past it, the guard:
  - clears `device_state.active_session_id`;
  - answers **401 `device_locked`**, for reads and writes alike.

  A write sent after the lock time is refused, so a stale tab cannot act as the previous person. A read is refused too, so the data on screen goes away with the lock.
- **Locking ends no session.** The person picks their name and types their PIN again.
- **The client runs the same timer** and shows the lock screen on time; the server rule is the guarantee.

### 3.7 Signing PIN (re-authentication)

- **A separate 6-digit PIN,** stored in `signing_pin_hash`.
  - **It can never equal the switch PIN.** Setting either PIN checks the candidate against the other hash and refuses a match (422 `PIN_SAME_AS_OTHER`).
  - Setting or changing the signing PIN needs a fresh full credential (password or OTP) in the same request, because it is a signature.
- **Grants.** `POST /api/auth/reauth {pin, purpose, entityId}` returns a grant that is:
  - **single use**;
  - valid for **2 minutes** (the DB caps any grant at 10);
  - bound to (session, user, purpose, entity).

  The operation's handler consumes the grant **inside its own transaction**:

  ```sql
  UPDATE reauth_grants SET used_at = now()
   WHERE id = $1 AND session_id = $2 AND staff_user_id = $3 AND purpose = $4 AND entity_id = $5
     AND used_at IS NULL AND expires_at > now()
  RETURNING id
  ```

  No row → 401 `reauth_required`. If the operation fails and rolls back, the grant stays unused.
- **Secrets accepted:** the signing PIN, or the account password. **Never the switch PIN.**
- **Failures count against the session.** A try is taken before the secret is checked, and the 5th wrong secret in a session ends that session (401 `session_revoked`).
- **Purposes** (a closed list in code):

| Purpose | Required for | `entityId` |
|---|---|---|
| `prescription.verify` | a prescriber confirming a prescription record (P-12) | the prescription |
| `container.lapse_override` | drawing from a lapsed container under `DOCTOR_OVERRIDE` (MR-17) | the container |
| `stock.reverse` | any reversal (E-35) | the document |
| `stock.backdate` | **(D-33)** any dispense, procedure use, patient return or GRN receipt recorded later than the reason-free lag (`backdate_reason_after_minutes`), i.e. whenever a backdate reason is required (MR-15) | the premises |
| `stock.writeoff` | write-offs and supplier returns (E-33; the write-off kinds of E-34) | the premises |
| `stock.adjust` | **stock-count adjustments** (`STOCKTAKE_ADJUSTMENT`, D-33) and manual opening balances (E-34) | the premises |
| `stock.import_commit` | committing an import (E-44) | the import |
| `premises.legal_settings` | dispensing mode, licences, register fields (E-05, E-06) | the premises |
| `register.export` | any register CSV or print (E-40) | the premises |
| `staff.manage` | create staff; reset; role or membership change (M-05 … M-08) | the staff user (the organisation, for a create) |
| `roles.manage` | custom roles and grant overrides (M-09) | the organisation |
| `devices.register` | trusting a PC (M-10) | the organisation |
| `org.settings` | security settings; creating or editing premises (M-01, M-03, M-04) | the organisation |
| `patients.merge` | merging or un-merging patients (P-16, P-17; D-36) | the surviving patient |

- **Ordinary work asks for no signing PIN:** dispensing, receiving and procedure use recorded at the time, or within the reason-free lag. The switch PIN already names the person, and a PIN on every sale would train people to share it.
- **Who gets a signing PIN (D-33).** Only people whose role holds at least one **PIN-gated permission**:
  - `rx.verify`;
  - `stock.backdate`, `stock.backdate_extended`;
  - `stock.writeoff`, `stock.adjust`, `stock.import`, `stock.settings`, `stock.registers`;
  - `patients.merge`;
  - `staff.manage`, `roles.manage`, `devices.manage`, `org.settings`.

  The catalogue in code marks these keys. With the default grants, every `owner`, `doctor` and `reception` user gets one (reception holds `stock.backdate`); a `store` user does not.
  - Setting a signing PIN without such a permission → 403 `signing_pin_not_applicable`.
  - When a role change or grant override removes a person's last PIN-gated permission, their signing PIN hash is cleared in the same transaction.
  - A person who needs one but has none is asked to set it at sign-in; until then, a gated action → 409 `signing_pin_not_set`.

### 3.8 Limits

| What | Rule | Kept in |
|---|---|---|
| Sign-in failures per IP | 20 per 15 min (a clinic's staff share one NAT address) → 429 `too_many_attempts` with `Retry-After` | memory (one replica; moved to the DB before a second) |
| Password failures per account, from an **untrusted** browser | The try is counted **before** the password is checked, so a burst checks at most 5. The 5th failure pauses password sign-in for that account for 15 min.<br>• A paused account answers exactly like a wrong password.<br>• **A pause never ends a live session.**<br>• OTP sign-in still works. | DB (`staff_users`) |
| Password failures on a **trusted device** | 5 per account per device per 15 min. After that, the device counts as untrusted for that account. | memory |
| Switch PIN | **Per user, across all devices:** 5 wrong in 15 min disables PIN switching for that person (`switch_pin_blocked`) until their next full sign-in. Other people are unaffected, and no session ends. | DB (`staff_users`) |
| Signing PIN or password re-auth | per session: the 5th wrong secret ends that session | DB (`sessions.secret_failures`) |
| OTP | 6 digits; 5-min TTL; 3 tries per code; 5 codes per phone per hour; 20 per IP per 15 min. A rate-limited phone looks the same as any other. | DB and memory |
| Passwords | 8–128 characters; not the login or the name; not on a short common-password list | — |
| PINs | exactly 6 digits; no repeats (000000-style) and no straight runs (123456, 654321); hashed with the pepper (§3.12) | — |

### 3.9 Phone OTP

- **Milestone 2** (D-39): nothing here is built until the templates below are approved.
- **Primary channel:** a WhatsApp **authentication template**, sent from a WhatsApp number **Engageo owns** and shared by every organisation. A clinic's own number is never used: if it were restricted, its staff could not sign in.
- **Fallback:** SMS through an Indian DLT-registered OTP provider. It is offered when WhatsApp has not delivered within 30 s, or on request.
- **Prerequisites before go-live** (06 §5, go-live gates):
  - an approved WhatsApp authentication template on Engageo's WABA;
  - on the DLT platform, a 6-character sender header and an approved OTP content template, bound to the chosen provider.
- **Cost** at one clinic's scale (about 12 staff, one sign-in a day each) is about ₹1.4 a day on WhatsApp. That is ₹0.115 per delivered authentication message, per Meta's India rate card from 2026-07-01, as researched for Spec 07.
- **Storage and logging:**
  - codes are stored as HMAC-SHA256 under a server key, never in clear, and bound to their challenge;
  - the phone is stored only as an HMAC;
  - neither is ever logged;
  - audited as `auth.otp_sent {channel}` and `auth.otp_failed {channel}`, never with the number.
- **No enumeration.** `otp/start` answers 202 with a challenge id for every well-formed number, known or not. The send happens after the response, so response time does not depend on whether the number is known. An unknown number gets a challenge that can never succeed.
- **Clerk was rejected** for Ritu Desk on 2026-10-07, and the same facts apply here:
  - India is off by default;
  - no India SMS price is published;
  - DLT handling is undocumented;
  - it has no PIN feature.

### 3.10 Organisation bootstrap (founder CLI)

There is no public sign-up. Engageo runs `scripts/create-org.ts` as `pharmacy_ops`. It:
- creates the organisation (`slug`, `display_name`), its first premises, its built-in roles and the first owner;
- prints the owner's one-time password **once**;
- writes the `org.created` and `staff.owner_bootstrapped` audit rows.

If the only owner is locked out, the same CLI recovers them (`--reset-owner`), audited. Everything else is done in the app by the owner.

### 3.11 Audit log

- **One `audit_log` per organisation.** Columns:
  - `at`, `staff_user_id`, `session_id`, `device_id`;
  - `actor_label` (a name snapshot) and `actor_role`;
  - `action`, `entity_id` (UUID);
  - `detail` (a JSONB object ≤ 2 KB).
- **Append-only, enforced three ways:**
  - a trigger refuses UPDATE and DELETE;
  - the app role has neither privilege, nor TRUNCATE;
  - the app role **does not own the table**, so it cannot disable the trigger.

  The role split is what makes the trigger binding.
- **No patient content.**
  - `detail` keys come from an allow-list.
  - Values are booleans, null, integers within ±1e9, UUIDs, UTC timestamps, lower-case tokens, or arrays of tokens.
  - Field names are recorded, never values.
- **Transactional writes** for security and legal changes, written in the same transaction as the change, so both land or neither does:
  - sign-in, PINs, staff, roles, devices;
  - security settings and premises legal settings;
  - prescription verify and void;
  - register exports.
- **Best-effort writes,** after commit, for ordinary record edits (a patient created or edited). A failed audit write there never turns a completed edit into an error.
- **Stock documents are not copied into the audit log.** The ledger and its documents already record the person, the time and the reason.

### 3.12 PIN hashing: a pepper outside the database (D-34)

**Why a pepper.** A 6-digit PIN has only a million values. Anyone holding a copy of the database could try them all against a plain scrypt hash in hours. A pepper is a secret mixed into every PIN hash that **never enters the database**, so a database copy alone is not enough.

- **Hash.** `scrypt(HMAC-SHA256(pepper_v, pin), salt)` with the §1.2 parameters, stored as `scrypt$15$8$1$p<v>$<salt>$<key>`. `p<v>` records which pepper version made the hash; the DB CHECKs that shape on `switch_pin_hash` and `signing_pin_hash`.
- **Where it lives.** `PIN_PEPPERS` is an environment secret on the web service (a Railway variable), never in the database, logs, backups or the repo. It holds an ordered list `v1:<base64 32 bytes>,v2:<…>`; the highest version is current. The jobs service does not get it.
- **Startup.** The app refuses to start if `PIN_PEPPERS` is missing, malformed, or has fewer than 32 bytes per entry. It also checks that every pepper version referenced by a stored hash is present (a count by version; no hash leaves the database).
- **Passwords** keep plain scrypt: at 8+ characters they are far costlier to guess. The same mechanism can be applied to them later if wanted.

**Rotating the pepper (routine, e.g. yearly or when someone with access leaves):**
1. Generate a new 32-byte secret, and append `v<n+1>:<secret>` to `PIN_PEPPERS` on the web service. Deploy. New PINs, and every PIN changed from now on, use `v<n+1>`.
2. **Lazy re-hash.** On every successful PIN check (switch, sign, or set), a hash on an older version is re-hashed with the current one in the same transaction. Staff type their switch PIN daily, so most hashes move within days.
3. Watch `pin_hash_versions` (the jobs service reports counts per version, never hashes) until the old version's count stops falling, normally 2–4 weeks.
4. **Retire the old version.** Clear every remaining hash on the old version (`UPDATE … SET switch_pin_hash = NULL WHERE …`, run by the migrator, audited as `auth.pin_pepper_retired {version, cleared}`), then remove the old entry from `PIN_PEPPERS` and deploy. Those people set a new PIN after their next full sign-in (password or OTP). Nothing else changes.

**Rotating after a suspected leak (emergency):** do step 1, then step 4 straight away, skipping the lazy re-hash. Everyone sets new PINs at their next full sign-in. Also rotate `SESSION_SECRET` (it ends every session) if the leak may include it.

**Never:** put the pepper in a table, a migration, a log line, a test fixture or CI output. Tests use a fixed test-only pepper defined in the harness (06b DPN-15 … 17).

---

## 4. Permissions (D-1, D-2, D-13, D-17)

### 4.1 Roles as data, defaults in code (the hybrid)

- **The catalogue is in code:**
  - the permission keys (§4.2);
  - which purposes need a signing PIN (§3.7).

  Routes check keys, so a key cannot be data.
- **Built-in roles.** `owner`, `doctor` and `reception` exist in every organisation as rows in `org_roles` (`builtin = true`), created at bootstrap. **Their default grants live in code** and are covered by the route-gate test (06b DX-77).
- **Overrides and custom roles are data:** `role_grants (org_id, role_key, permission, allowed)`. A custom role, e.g. `store`, has only the grants its rows give it. This meets the founder's D-2 ("permissions stored as data") without losing tested defaults.
- **Every change to a grant or a custom role is audited in the same transaction:** `role.grant_changed {role, permission, from, to}`, `role.created`, `role.changed`. A change that cannot be audited is not made.
- **An organisation cannot lock itself out:**
  - `owner` cannot lose `staff.manage`, `roles.manage` or `org.settings` (422 `OWNER_GRANT_LOCKED`);
  - the last active owner cannot be deactivated or demoted (409 `last_owner`).

### 4.2 Permission keys and defaults

| Permission | Allows | owner | doctor | reception |
|---|---|---|---|---|
| **Administration** | | | | |
| `org.settings` | security settings; creating and editing premises (address, state, GSTIN) | ✓ | | |
| `staff.manage` | staff accounts, memberships, resets, sessions | ✓ | | |
| `roles.manage` | custom roles; grant overrides | ✓ | | |
| `devices.manage` | trusting and revoking PCs | ✓ | | |
| `audit.view` | reading the audit log | ✓ | | |
| **People and prescriptions** | | | | |
| `patients.view` | searching and reading patients | ✓ | ✓ | ✓ |
| `patients.edit` | creating and editing patients | ✓ | ✓ | ✓ |
| `patients.merge` | merging and un-merging duplicate patients (D-36; signing PIN) | ✓ | | |
| `prescribers.manage` | creating and editing prescribers | ✓ | | |
| `rx.view` | reading prescription records, photos included | ✓ | ✓ | ✓ |
| `rx.enter` | recording a prescription (photo or manual); adding transcription lines; voiding an undispensed record | ✓ | ✓ | ✓ |
| `rx.verify` | confirming a prescription record **as its prescriber** (also needs the prescriber link, §3.2) | ✓ | ✓ | |
| **Stock** | | | | |
| `stock.view` | items, units, batches, balances, ledger history, containers (no patient data), **at the user's own premises** (owner: all) | ✓ | ✓ | ✓ |
| `stock.items` | items, units, tax rates, suppliers | ✓ | | |
| `stock.receive` | creating, editing, posting and discarding GRNs | ✓ | | ✓ |
| `stock.dispense` | dispense, preview, patient returns, procedure use, opening and discarding containers | ✓ | ✓ | ✓ |
| `stock.backdate` | backdating a dispense, procedure use, patient return or receipt within the **standard** window (default 48 h, §11.4) | ✓ | ✓ | ✓ |
| `stock.backdate_extended` | the same, up to the **extended** window (default 7 days) | ✓ | | |
| `dispense.view` | reading patient-linked stock documents (org-wide: one patient across premises) | ✓ | ✓ | ✓ |
| `stock.writeoff` | write-offs; supplier returns | ✓ | | |
| `stock.adjust` | stock adjustments; manual opening balances; **reversals of any document** | ✓ | | |
| `stock.import` | opening-balance import | ✓ | | |
| `stock.reports` | stock reports without patient data | ✓ | ✓ | |
| `stock.registers` | the H1 and purchase registers; any export with patient data | ✓ | ✓ | |
| `stock.settings` | stock settings; per-premises mode, licences and register fields; locations; procedure types | ✓ | | |

- **Backdating is tiered (D-13).** Reception and doctors get the standard window; the extended window is owner-only.
- **Permission before lookup.** A user without the permission gets **403 `forbidden`** whether or not the id exists, so a 403 never reveals existence.
- **Out-of-tenant ids.** A user with the permission who names another tenant's id gets **404**, identical to a missing id.

### 4.3 Seeing stock vs seeing who received it (D-1)

| Data | Contains patient identity? | Gated by |
|---|---|---|
| items, batches, balances, ledger history, GRNs, supplier returns, adjustments, containers, stock reports | **never** | `stock.view`, `stock.reports` |
| patients | yes | `patients.view` |
| prescription records and their photos | yes | `rx.view` |
| dispenses, patient returns, a procedure use's patient link, the H1 register, any export with patient fields | yes | `dispense.view`, `stock.registers` |

- **`stock_movements` and `stock_balances` carry no patient id.** A ledger row for a dispense references the allocation, not the patient.
- **A stock-only role sees no patient name anywhere.** A role holding `stock.view` but none of `patients.view`, `rx.view` or `dispense.view` (e.g. `store`) never sees one (06b DI-08).
- **Go-live condition attached to D-1:** a signed data-processing agreement with each organisation (06 OQ-24). A medication history reveals conditions.

### 4.4 Premises scope (D-17)

- **Stock reads and every stock-moving operation are restricted to the premises in the user's membership.** Staff can only dispense stock that is physically there. `owner` sees and acts at every premises.
- **A premises outside the user's membership** gets **404 `PREMISES_NOT_FOUND`**, identical to a nonexistent one.
- **Patient-linked history stays org-wide:** patients, prescription records and `dispense.view` documents. A patient is one record across branches.

---

## 5. Conventions

| Concern | Rule |
|---|---|
| Primary keys | `id UUID NOT NULL DEFAULT gen_random_uuid()`, with **`PRIMARY KEY (org_id, id)`** on every tenant table (§2.6). Only `organisations` and `medicine_master` are keyed on `id` alone. |
| Tenant column | `org_id UUID NOT NULL REFERENCES organisations(id) ON DELETE RESTRICT`, **never with a default** (Spec 03 §1). Branch-level tables also carry `premises_id` with a composite FK. |
| Tenant integrity | Every FK between tenant tables is composite on `org_id`; batch- and location-naming rows add `premises_id`; every unique constraint includes `org_id` (§2.6) |
| Enumerations | `TEXT` plus a named `CHECK` |
| Quantities | `INTEGER` base units. `qty_entered NUMERIC(12,3)` keeps exactly what staff typed. |
| Money | `BIGINT` paise. **Every money column name ends in `_paise`.** |
| Rates | GST as `INTEGER` basis points (`1200` = 12.00 %) |
| Time | `TIMESTAMPTZ` stored in UTC; `DATE` for printed or business dates. IST in SQL: `(ts AT TIME ZONE 'Asia/Kolkata')::date`; in TypeScript: `lib/time.ts`. |
| Clock | an injectable `lib/clock.ts`; every server timestamp comes from it, so tests can pin time |
| DB access | only through `withTenant()` on the shared pool (`lib/db/pool.ts`). A lint forbids `.query(` outside `lib/db/`. |
| **`BIGINT` from node-postgres (D-15)** | `pg` returns `int8` **as a string**, so `"100" + "200"` gives `"100200"`.<br>• **One global type parser** in `lib/db/pool.ts` turns `int8` into a `Number` and **throws unless `Number.isSafeInteger`**. (Rev 3 set it per query, to avoid changing the desk's existing `COUNT(*)` results; a new app has no such callers.)<br>• **A test** walks every API response in the suite and asserts every key ending in `Paise`/`_paise` is a safe-integer `number` (06b DH-11).<br>• Paise up to 2^53 (≈ ₹90 trillion) are safe. |
| **`NUMERIC` from node-postgres** | returned as a string; **never `parseFloat`**. Quantities are handled as integer milli-units: `"1.5"` → `1500`, and `qty_base = milli × factor / 1000` must divide exactly. |
| Money at the edges | API JSON carries integer paise (`unitPricePaise: 4500`); non-integers are rejected. Display uses `fmtPaise()`: 2 decimals, Latin digits. No `/ 100` on money anywhere. |
| Errors | `{ error, code, requestId?, details? }` everywhere. **Lower-case codes are identity and access** (`unauthenticated`, `invalid_credentials`, `forbidden`, `device_locked`, `reauth_required`, `session_revoked` …). **Upper-case codes are domain codes** (`INSUFFICIENT_STOCK` …). `details` never echoes input values. |
| Request validation | hand-written through `strictBody()`, which **rejects unknown keys** (422). No schema accepts `orgId`. |
| Actor | `actor_staff_id` (composite FK → `staff_users`) and `actor_label` (a name snapshot), both from the session: always the device's **active** person (§3.5) |
| Phone numbers | E.164 (`+91…`), normalised on input; never logged |
| Batch numbers | stored normalised: `upper(trim(regexp_replace(batch_no, '\s+', ' ', 'g')))` |
| Logs | Structured JSON. **Never:**<br>• a patient name or phone;<br>• prescription text;<br>• an item name;<br>• a patient↔item pair.<br>Validation errors log `{field, code}` only. |

---

## 6. Data model

Implied on every tenant table and not repeated:
- `id`, `org_id`, `created_at`;
- `PRIMARY KEY (org_id, id)`, and the other §2.6 rules;
- RLS enabled and forced, with the tenant policy.

Everything is **Phase 1** unless marked. **P1-C** means Phase 1 *conditional* on 06 OQ-1 (the pilot clinic goes first and does injectables).

### 6.1 Tenancy and identity

**`organisations`** (the tenant root; RLS on `id`)

| Column | Type | Notes |
|---|---|---|
| `slug` | TEXT NOT NULL UNIQUE | CHECK `^[a-z0-9][a-z0-9-]{2,39}$`; used in the sign-in link |
| `display_name` | TEXT NOT NULL | |
| `legal_name` | TEXT NULL | |
| `status` | TEXT NOT NULL DEFAULT `'ACTIVE'` | CHECK (`ACTIVE`,`SUSPENDED`). A suspended organisation cannot sign in. |

**`premises`**

| Column | Type | Notes |
|---|---|---|
| `name` | TEXT NOT NULL | UNIQUE (`org_id`, `lower(name)`) |
| `address` | TEXT NOT NULL | printed on registers |
| `state_code` | CHAR(2) NOT NULL | the GST state code (`24` Gujarat, `27` Maharashtra); CHECK `^[0-9]{2}$` |
| `gstin` | TEXT NULL | CHECK format `^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$`, and its first two digits equal `state_code` |
| `legal_name` | TEXT NULL | |
| `active` | BOOLEAN NOT NULL DEFAULT true | |

**`org_settings`**: one row per organisation (PK `org_id`); security and session settings.

| Column | Type | Notes |
|---|---|---|
| `device_lock_minutes` | INTEGER NOT NULL DEFAULT 3 | CHECK 1–10 (§3.6) |
| `day_reset_time_ist` | TIME NOT NULL DEFAULT `'04:00'` | sessions end at the next occurrence (§3.4) |
| `untrusted_idle_minutes` | INTEGER NULL | CHECK 5–720; NULL = off (§3.4) |
| `version`, `updated_by`, `updated_at` | | optimistic concurrency via `If-Match` |

`org_settings_history` is append-only, with one full snapshot per change.

**`org_roles`** and **`role_grants`** (§4.1)

| Table | Columns |
|---|---|
| `org_roles` | `key` TEXT (CHECK `^[a-z][a-z0-9_]{1,31}$`), `name`, `builtin` BOOLEAN; UNIQUE (`org_id`, `key`). A trigger forbids deleting or renaming a built-in role. |
| `role_grants` | `role_key` (composite FK → `org_roles (org_id, key)`), `permission` TEXT (CHECK `^[a-z]+(\.[a-z_]+)+$`; the service checks it against the catalogue), `allowed` BOOLEAN, `updated_by`, `updated_at`; UNIQUE (`org_id`, `role_key`, `permission`) |

**`staff_users`**

| Column | Type | Notes |
|---|---|---|
| `name` | TEXT NOT NULL | 1–64 characters; UNIQUE (`org_id`, `lower(name)`) |
| `login` | TEXT NOT NULL | lower-case; CHECK `^[a-z0-9._-]{3,32}$`; UNIQUE (`org_id`, `login`) |
| `phone_e164` | TEXT NULL | CHECK `^\+[1-9][0-9]{7,14}$`; partial UNIQUE (`org_id`, `phone_e164`) |
| `role_key` | TEXT NOT NULL | composite FK → `org_roles` |
| `prescriber_id` | UUID NULL | composite FK → `prescribers`; partial UNIQUE (`org_id`, `prescriber_id`): one login per prescriber |
| `password_hash` | TEXT NULL | CHECK the scrypt shape `^scrypt\$15\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$`. CHECK (`password_hash IS NOT NULL OR phone_e164 IS NOT NULL`). |
| `must_change_password` | BOOLEAN NOT NULL DEFAULT false | |
| `switch_pin_hash`, `signing_pin_hash` | TEXT NULL | CHECK the peppered shape `^scrypt\$15\$8\$1\$p[0-9]{1,3}\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$` (§3.12). `signing_pin_hash` is NULL unless the role holds a PIN-gated permission (§3.7). |
| `password_failures`, `password_paused_until` | INTEGER, TIMESTAMPTZ | the untrusted-browser counter (§3.8) |
| `switch_pin_failures`, `switch_pin_window_from`, `switch_pin_blocked` | INTEGER, TIMESTAMPTZ, BOOLEAN | the per-user switch-PIN limit (§3.8) |
| `active` | BOOLEAN NOT NULL DEFAULT true | |
| `last_sign_in_at` | TIMESTAMPTZ NULL | |

**`staff_premises`**: `staff_user_id`, `premises_id` (composite FKs), `active`; UNIQUE (`org_id`, `staff_user_id`, `premises_id`).

**`devices`**

| Column | Type | Notes |
|---|---|---|
| `premises_id` | UUID NOT NULL | composite FK |
| `name` | TEXT NOT NULL | partial UNIQUE (`org_id`, `lower(name)`) WHERE `revoked_at IS NULL` |
| `registered_by`, `registered_at` | | |
| `revoked_at`, `revoked_by` | NULL | |
| `last_seen_at` | TIMESTAMPTZ | |

**`sessions`**

| Column | Type | Notes |
|---|---|---|
| `staff_user_id` | UUID NOT NULL | composite FK |
| `device_id` | UUID NULL | composite FK; NULL = an untrusted browser |
| `method` | TEXT NOT NULL | CHECK (`PASSWORD`,`OTP`) |
| `expires_at` | TIMESTAMPTZ NOT NULL | CHECK `expires_at <= created_at + interval '16 hours'` |
| `last_input_at` | TIMESTAMPTZ NOT NULL | real input only (§3.6) |
| `secret_failures` | INTEGER NOT NULL DEFAULT 0 | §3.7 |
| `revoked_at`, `revoked_reason` | | `revoked_reason` CHECK in (`sign_out`, `sign_out_all`, `replaced`, `expired`, `idle`, `wrong_secrets`, `deactivated`, `role_changed`, `password_changed`, `password_reset`, `device_revoked`, `owner_revoked`) |

**`device_state`**: one row per device (PK (`org_id`, `device_id`)): `active_session_id` (composite FK → `sessions`, NULL = locked), `updated_at`. It is kept separate from `devices` so that devices and sessions do not reference each other.

**`otp_challenges`**

| Column | Notes |
|---|---|
| `staff_user_id` | composite FK; NULL for an unknown phone (a challenge that cannot succeed, §3.9) |
| `phone_hmac`, `code_hmac` | HMAC-SHA256 under a server key; no phone or code in clear |
| `channel` | CHECK (`WHATSAPP`,`SMS`) |
| `expires_at` | CHECK `expires_at <= created_at + interval '5 minutes'` |
| `attempts` | CHECK 0–3 |
| `consumed_at`, `ip_hmac` | |

Purged after one day.

**`reauth_grants`**: `session_id`, `staff_user_id` (composite FKs), `purpose` (CHECK in the §3.7 list), `entity_id`, `expires_at` (CHECK `<= created_at + interval '10 minutes'`), `used_at`.

**`audit_log`** (§3.11)

| Column | Notes |
|---|---|
| `at` | |
| `staff_user_id`, `session_id`, `device_id` | plain UUIDs, not FKs, so that purging sessions never touches the audit trail |
| `actor_label` | a name snapshot |
| `actor_role` | a role key snapshot, or `founder_cli` / `system` |
| `action` | e.g. `auth.switched` |
| `entity_id` | UUID |
| `detail` | JSONB object ≤ 2 KB; allow-listed keys only |

Append-only (§7.3).

### 6.2 Patients, prescribers and prescriptions (D-26)

**`patients`**: one record per person per organisation, shared across its premises.

| Column | Type | Notes |
|---|---|---|
| `name` | TEXT NOT NULL | 1–100 characters |
| `phone_e164` | TEXT NULL | **not unique** (families share phones); indexed |
| `address` | TEXT NULL | needed only where a premises' H1 register asks for it (MR-22) |
| `dob` | DATE NULL | the same |
| `created_by`, `updated_by`, `updated_at` | | |
| `archived_at`, `archived_by` | NULL | archived, never deleted. A patient referenced by any document cannot be deleted (FK `RESTRICT`). |

- **The phone number is not unique** (D-36): one phone often serves a whole family.
- **Matching is on name + phone.** Creating a patient whose normalised phone matches an existing patient **and** whose name is similar (trigram similarity ≥ 0.6) returns the non-blocking warning `POSSIBLE_DUPLICATE`, with the candidates' ids. The user picks one or creates anyway. The same rule lists likely duplicates for the merge tool (P-15). A shared phone with a dissimilar name (a sibling, a parent) is never proposed.
- **Nothing clinical is stored:** no diagnosis, allergies or notes.

**`patient_merges`** (D-36): the record of a merge. **A merge never rewrites a dispense, a ledger row, a prescription or any other document.** It is recorded here and resolved at read time.

| Column | Type | Notes |
|---|---|---|
| `survivor_patient_id` | UUID NOT NULL | composite FK → `patients` |
| `merged_patient_id` | UUID NOT NULL | composite FK → `patients`; CHECK `<> survivor_patient_id` |
| `reason` | TEXT NOT NULL | ≤ 200 characters; no clinical content |
| `merged_by`, `merged_at` | | composite FK → `staff_users` |
| `undone_by`, `undone_at` | NULL | both or neither (CHECK) |

- Partial UNIQUE (`org_id`, `merged_patient_id`) WHERE `undone_at IS NULL`: a patient is merged into at most one survivor at a time.
- A trigger refuses a merge whose survivor is itself currently merged (merge into the end of the chain instead) and any merge that would make a cycle.
- Rows are never deleted. An undo sets `undone_*` once (trigger); merging again needs a new row.

**Read-time resolution.** A view `patient_canonical (patient_id, canonical_patient_id)` follows the non-undone merges (a recursive CTE over at most a few rows per patient).
- Patient history (dispenses, procedure uses, prescriptions, returns) is read by `canonical_patient_id`, so the survivor's history includes the merged patient's documents.
- Patient search hides currently merged patients.
- The H1 register is unaffected: it prints the snapshots taken at supply.
- Every "same patient" rule (MR-21; the prescription, return and dispense links) compares **canonical** ids, as of the operation.
- A new document naming a merged patient → 409 `PATIENT_MERGED`, with `details.survivorId`, so staff continue on the survivor.
- **Undo** simply stops the resolution, because nothing was rewritten.

**`prescribers`**: org-level; the H1 register needs each prescriber's name, registration number and address.

| Column | Type | Notes |
|---|---|---|
| `kind` | TEXT NOT NULL | CHECK (`INTERNAL`,`EXTERNAL`). `INTERNAL` practises at this organisation. `EXTERNAL` is an outside doctor (Phase 2, `LICENSED_PHARMACY`). |
| `name` | TEXT NOT NULL | |
| `registration_no` | TEXT NULL | required for dispensing at an RMP premises (MR-02) |
| `council` | TEXT NULL | the medical council of that registration, e.g. "Gujarat Medical Council"; required with it (MR-02) |
| `qualification` | TEXT NULL | |
| `address` | TEXT NULL | For `INTERNAL`, NULL means "the address of the premises where the supply happens" (snapshotted per dispense). CHECK (`kind = 'INTERNAL' OR address IS NOT NULL`). |
| `phone_e164` | TEXT NULL | |
| `active` | BOOLEAN NOT NULL DEFAULT true | |

**`prescriptions`**: a record of a prescription a doctor wrote. **This app never writes prescriptions.**

| Column | Type | Notes |
|---|---|---|
| `premises_id` | UUID NOT NULL | composite FK; where it was recorded |
| `patient_id` | UUID NOT NULL | composite FK → `patients` |
| `prescriber_id` | UUID NOT NULL | composite FK → `prescribers` |
| `source` | TEXT NOT NULL | CHECK (`PHOTO`,`MANUAL`) |
| `prescribed_on` | DATE NOT NULL | the date on the prescription; CHECK not after the IST date of `created_at` |
| `serial_text` | TEXT NULL | the number printed or written on it, if any |
| `entered_by` | UUID NOT NULL | composite FK → `staff_users` |
| `verified_by_staff_id`, `verified_at` | NULL | set only by the prescriber's own linked user, with a signing PIN (P-12); both or neither (CHECK) |
| `status` | TEXT NOT NULL DEFAULT `'ACTIVE'` | CHECK (`ACTIVE`,`VOID`) |
| `void_reason`, `voided_by`, `voided_at` | | CHECK: present iff `status = 'VOID'` |

- **The header is immutable after creation** (trigger), except:
  - `verified_*`, set once from NULL;
  - `status`, once from `ACTIVE` to `VOID`.
- **Voiding is refused while any non-reversed dispense line references the prescription** (409 `PRESCRIPTION_HAS_DISPENSES`).
- **A `PHOTO` prescription needs at least one image** before it can be used for dispensing (MR-21).

**`prescription_lines`**: typed by staff; there is no OCR.

| Column | Type | Notes |
|---|---|---|
| `prescription_id` | UUID NOT NULL | composite FK; UNIQUE (`org_id`, `prescription_id`, `id`), so a dispense line can reference "a line of this prescription" |
| `line_no` | INTEGER NOT NULL | UNIQUE (`org_id`, `prescription_id`, `line_no`) |
| `medicine_text` | TEXT NOT NULL | as written, e.g. "Isotretinoin 20 mg" |
| `item_id` | UUID NULL | composite FK → `items`: the stock item staff matched the line to at entry. For ordinary items it is a **pre-selection only**: dispensing still needs a human to confirm the item. For MR-18 items it is binding (MR-18). |
| `qty_text` | TEXT NULL | as written, e.g. "1 OD × 30 days" |
| `qty_base_prescribed` | INTEGER NULL | CHECK > 0. The total quantity in base units, **typed by staff from the prescription, never computed from a dose**. Required on a line used for an MR-18 item. |
| `entered_by` | UUID NOT NULL | |

**Lines are never edited once a dispense references them** (trigger). New lines may still be added, e.g. a second medicine transcribed later.

**`prescription_images`**

| Column | Type | Notes |
|---|---|---|
| `prescription_id` | UUID NOT NULL | composite FK |
| `page_no` | SMALLINT NOT NULL | UNIQUE (`org_id`, `prescription_id`, `page_no`) |
| `mime_type` | TEXT NOT NULL | CHECK (`image/jpeg`,`image/png`). Sniffed from magic bytes; the uploaded type is never trusted. |
| `bytes` | BYTEA NOT NULL | |
| `byte_size` | INTEGER NOT NULL | CHECK 1–2,097,152 AND `octet_length(bytes) = byte_size` |
| `sha256` | TEXT NOT NULL | CHECK `^[0-9a-f]{64}$` |
| `width_px`, `height_px` | INTEGER | |
| `uploaded_by` | UUID NOT NULL | |

- **Their own table** (D-35). Image bytes are never stored on `prescriptions` or anywhere else, so moving them later touches one table.
- **Compressed in the browser** (D-35). Before upload the browser:
  - converts a phone's HEIC;
  - scales the long edge to ≤ 1600 px;
  - re-encodes as JPEG, stepping quality down from 0.8 until the file is **≤ 400 KB** (target 200–400 KB, enough to read handwriting);
  - **keeps the server cap of 2 MiB:** a file over it gets 413, whatever the client did.
- **Moving to object storage at 10 GB** (D-35).
  - **Threshold:** when `sum(byte_size)` across all organisations reaches **10 GB**, images move to object storage: an S3-compatible bucket in an Indian region, private, served through short-lived signed URLs. This table then keeps the metadata and the object key. That change gets its own spec.
  - **Why 10 GB:** at about 300 KB a photo, that is roughly 35,000 prescriptions. Below it, the photos keep the database backup and the restore drill (06b DMG-10) quick on Railway.
  - **The jobs service reports the total weekly** and alerts at **8 GB** (80 %), so the move is planned, not forced (06b DJ-12).
- **Immutable.** There is no UPDATE. DELETE is allowed only while the prescription has no dispense (trigger).
- **Served only through P-11,** with `Cache-Control: no-store`.
- **Never processed:** images are never sent to an external service and never read by any code except the image route. No OCR, no AI.

**`procedure_types`**: the organisation's list of procedures (e.g. "Chemical peel"). `name` is UNIQUE (`org_id`, `lower(name)`); plus `active`. They label procedure uses and group the consumption report.

### 6.3 Global: `medicine_master`

`medicine_master` has no `org_id` and no RLS. The app role has SELECT only; `pharmacy_curator` writes it.

| Column | Type | Constraints / notes |
|---|---|---|
| `id` | UUID | PK |
| `brand_name` | TEXT | NOT NULL |
| `manufacturer_name` | TEXT | NOT NULL |
| `manufacturer_address` | TEXT | NULL. Needed for the Schedule K purchase record. |
| `dosage_form` | TEXT | CHECK in (`TABLET`,`CAPSULE`,`SYRUP`,`SUSPENSION`,`INJECTION`,`CREAM`,`OINTMENT`,`GEL`,`LOTION`,`SOLUTION`,`DROPS`,`POWDER`,`SACHET`,`SPRAY`,`SHAMPOO`,`SOAP`,`SERUM`,`PATCH`,`DEVICE`,`OTHER`) |
| `strength_text`, `pack_text` | TEXT | as printed |
| `suggested_base_unit`, `suggested_units JSONB` | | hints for item creation only (`[{"name":"strip","baseUnits":15}]`) |
| `hsn_code` | TEXT | |
| `salts` | JSONB NOT NULL DEFAULT `'[]'` | `[{"name":"Isotretinoin","strength":"20 mg"}]`; CHECK `jsonb_typeof = 'array'`; GIN index |
| `schedule_flags` | TEXT[] NOT NULL DEFAULT `'{}'` | CHECK `<@ ARRAY['H','H1','X','G','NDPS','H2']` |
| `requires_prescription` | BOOLEAN NOT NULL DEFAULT false | **D-23, D-32.** The central suggestion that items copy (§6.5). **Starting values** are in the reviewed master seed (`data/master/`): `true` on every **oral** isotretinoin and acitretin entry (topical forms stay `false`). Raising it later is a data change, never a deploy, and **no drug name is written into code**. |
| `storage_condition` | TEXT | CHECK in (`ROOM_TEMPERATURE`,`BELOW_25C`,`BELOW_30C`,`COLD_2_8C`,`FROZEN`) |
| `source`, `source_ref` | TEXT | provenance (06 OQ-5) |
| `verified`, `verified_by`, `verified_at` | | |
| `version` | INTEGER NOT NULL DEFAULT 1 | bumped on every curation |
| `discontinued` | BOOLEAN NOT NULL DEFAULT false | |

Index: trigram GIN on `lower(brand_name)` (`pg_trgm`), for import matching and search.

### 6.4 Configuration

**`stock_settings`**: one row per organisation (PK `org_id`).

| Column | Type | Notes |
|---|---|---|
| `near_expiry_windows_days` | INTEGER[] NOT NULL DEFAULT `'{30,60,90}'` | CHECK all > 0, ≤ 3 entries |
| `dispense_reversal_window_hours` | INTEGER NOT NULL DEFAULT 24 | CHECK 0–168. Measured from `recorded_at`; past the window, use a patient return. |
| `backdate_reason_after_minutes` | INTEGER NOT NULL DEFAULT 120 | CHECK 10–1440. **Per-organisation data (D-12):** a lag up to this needs no reason. Desks enter everything after the patient leaves, so a 10-minute rule would fire on most entries and train staff to type "ok". Tune it from pilot data with the lag report (§14). |
| `scheduled_entry_max_minutes` | INTEGER NOT NULL DEFAULT 30 | **D-22.** CHECK 0–120. The maximum `recorded_at − occurred_at` for any dispense or procedure use with an **H1, X or NDPS** line. It is **separate from** the reason-free lag and never larger than it, and no reason or tier extends it. H1 supplies are entered at the time of supply. |
| `backdate_window_hours` | INTEGER NOT NULL DEFAULT 48 | CHECK 0–168. The **standard** tier (`stock.backdate`); 0 disables backdating (§11.4). |
| `backdate_extended_window_hours` | INTEGER NOT NULL DEFAULT 168 | CHECK from `backdate_window_hours` to 168. The **extended** tier (`stock.backdate_extended`, owner). The DB hard cap is 7 days. |
| `procedure_use_patient_link` | TEXT NOT NULL DEFAULT `'REQUIRED_FOR_INJECTABLES'` | CHECK in (`OPTIONAL`,`REQUIRED_FOR_INJECTABLES`,`REQUIRED`); batch-to-patient traceability for recalls |
| `opened_container_lapse_policy` | TEXT NOT NULL DEFAULT `'BLOCK'` | **P1-C, D-16.** CHECK in (`BLOCK`,`DOCTOR_OVERRIDE`). Clinic policy, chosen explicitly after asking the doctor whether they ever inject past the label time (06 OQ-27).<br>• `DOCTOR_OVERRIDE` lets a prescriber-linked session draw from a lapsed container, with a mandatory reason and a signing PIN.<br>• Every override appears on the lapsed-use report (§14). |
| `intra_state_transfers_enabled` | BOOLEAN NOT NULL DEFAULT false | Phase 2, D-19. Turned on per organisation only after the clinic's CA signs off. |
| `version`, `updated_by`, `updated_at` | | optimistic concurrency via `If-Match` |

**`premises_settings`**: one row per premises (PK (`org_id`, `premises_id`)). **The legal configuration lives here (D-6).**

| Column | Type | Notes |
|---|---|---|
| `dispensing_mode` | TEXT NOT NULL | CHECK in (`RMP_OWN_PATIENTS`,`LICENSED_PHARMACY`,`CONSUMABLES_ONLY`). **No default:** chosen explicitly per premises. |
| `ndps_licence_no`, `ndps_licence_valid_till` | TEXT, DATE | NULL = no NDPS licence at this premises |
| `schedule_x_licence_no`, `schedule_x_licence_valid_till` | TEXT, DATE | |
| `retail_drug_licence_numbers`, `retail_licence_valid_till` | TEXT[], DATE | Phase 2; CHECK non-empty when the mode is `LICENSED_PHARMACY` |
| `h1_register_extra_fields` | TEXT[] NOT NULL DEFAULT `'{}'` | CHECK `<@ ARRAY['PATIENT_ADDRESS','PATIENT_AGE','PATIENT_DOB','PRESCRIPTION_DATE']`. State advisories differ (06 OQ-9). |
| `prescription_max_age_days` | INTEGER NULL | CHECK 1–365. NULL = no age limit (06 OQ-32). It applies when a dispense links a prescription (MR-21). |
| `version`, `updated_by`, `updated_at` | | |

**`stock_settings_history`** and **`premises_settings_history`**: append-only (§7.3).
- Each row is a full snapshot with `valid_from`, the actor and the time.
- A mode change has legal weight. A backdated entry is checked against the premises' mode and licences *as of its `occurred_at`* (§11.4), and only this history makes that answerable.

**`stock_locations`**: storage places **within a premises**.

| Column | Type | Notes |
|---|---|---|
| `premises_id` | UUID NOT NULL | composite FK; UNIQUE (`org_id`, `premises_id`, `id`), so documents can reference (premises, location) consistently |
| `name` | TEXT NOT NULL | UNIQUE (`org_id`, `premises_id`, `lower(name)`) |
| `kind` | TEXT NOT NULL | CHECK in (`STORE`,`PROCEDURE_ROOM`,`FRIDGE`,`QUARANTINE`) |
| `storage_condition` | TEXT NULL | e.g. a fridge is `COLD_2_8C` |
| `is_default` | BOOLEAN NOT NULL | partial UNIQUE (`org_id`, `premises_id`) WHERE `is_default` |
| `active` | BOOLEAN NOT NULL DEFAULT true | |

Phase 1 creates **two locations per configured premises:**
- the default `STORE`;
- a `QUARANTINE` location, partial UNIQUE (`org_id`, `premises_id`) WHERE `kind = 'QUARANTINE'`.

**Quarantine (D-14).**
- Stock in a `QUARANTINE` location can leave **only** by `EXPIRY_WRITEOFF`, `DAMAGE_WRITEOFF`, `SUPPLIER_RETURN`, or a `REVERSAL` of the movement that put it there. A trigger enforces this (L-20).
- It is never an allocation candidate.
- Expired batches arriving through an opening balance land there automatically. So onboarding records the expired stock actually on the shelf instead of hiding it, and the only way it can leave the books is the way it should leave the shelf.

Further locations within a premises are Phase 2. Every balance and movement already carries `location_id`, so that phase needs no data migration.

### 6.5 Catalogue (org-wide: one catalogue per business)

**`items`**

| Column | Type | Notes |
|---|---|---|
| `master_id` | UUID NULL | FK `medicine_master(id)` RESTRICT; NULL for custom items. Partial UNIQUE (`org_id`, `master_id`). |
| `category` | TEXT NOT NULL | CHECK in (`MEDICINE`,`RETAIL_PRODUCT`,`INJECTABLE`,`CONSUMABLE`) |
| `display_name` | TEXT NOT NULL | UNIQUE (`org_id`, `lower(display_name)`) |
| `base_unit` | TEXT NOT NULL | CHECK in (`TABLET`,`CAPSULE`,`ML`,`G`,`VIAL`,`UNIT`,`PIECE`). `UNIT` is the dose unit of a multi-dose injectable. |
| `track_batches` | BOOLEAN NOT NULL | CHECK (`track_batches` OR `category = 'CONSUMABLE'`) |
| `extra_schedule_flags` | TEXT[] NOT NULL DEFAULT `'{}'` | CHECK subset, as on the master. **Effective flags = master ∪ extra**, so an organisation can add a flag but never remove one the master has. |
| `requires_prescription` | BOOLEAN NOT NULL DEFAULT false | **D-32: the flag MR-18 reads, stored on the item as data.**<br>• **Set at creation** from the master's `requires_prescription`.<br>• **Kept true by a trigger** while the linked master has it, or while the item's effective schedule flags include `X`. So the starting values are oral isotretinoin and acitretin (from the master seed) and every Schedule X item.<br>• An organisation may set it on any other item, and clear it only where neither the master nor `X` imposes it (owner, audited `item.requires_prescription_changed`); otherwise 422 `REQUIRES_PRESCRIPTION_IMPOSED`.<br>• **When curation later raises a master's flag,** the daily job raises it on every linked item (`item.requires_prescription_raised {count}`). Until then MR-18 treats the master's flag as a backstop, so the rule applies at once.<br>• Custom items without a master link: 06 OQ-29. |
| `custom_manufacturer_name`, `custom_manufacturer_address` | TEXT | for custom items, or where the master lacks an address |
| `hsn_code_override`, `storage_condition` | TEXT NULL | |
| `reorder_level`, `reorder_qty` | INTEGER NULL | base units; CHECK ≥ 0 / > 0. **Applied per premises** in Phase 1 (the same level at each premises); per-premises overrides are Phase 2. |
| `rack_location` | TEXT NULL | |
| `container_unit_id` | UUID NULL | **P1-C.** Composite FK to this item's `item_units`: the unit that is opened, e.g. `vial` = 100 `UNIT`. |
| `in_use_hours` | INTEGER NULL | **P1-C.** CHECK > 0. How long an opened container may be used, **copied by staff from the product label**, never computed. CHECK (`container_unit_id IS NULL`) = (`in_use_hours IS NULL`). |
| `active` | BOOLEAN NOT NULL DEFAULT true | |

Trigger `items_freeze`: once any movement exists for the item, `base_unit`, `track_batches`, `master_id` and `container_unit_id` are immutable.

**`item_units`**: the pack hierarchy, stored as a direct factor to the base unit (box = 150 tablets, not "box = 10 strips").

| Column | Type | Notes |
|---|---|---|
| `item_id` | UUID | composite FK; also UNIQUE (`org_id`, `item_id`, `id`), so batches and lines can reference "a unit *of this item*" |
| `name` | TEXT NOT NULL | UNIQUE (`org_id`, `item_id`, `lower(name)`) |
| `base_units_per_unit` | INTEGER NOT NULL | CHECK > 0. **Immutable:** a trigger rejects updates. To change a pack size, deactivate the unit and add a new one. |
| `is_base` | BOOLEAN NOT NULL | partial UNIQUE (`org_id`, `item_id`) WHERE `is_base`; CHECK (NOT `is_base` OR factor = 1) |
| `dispensable`, `purchasable`, `active` | BOOLEAN | |

**`item_tax_rates`**: keyed by HSN, because GST attaches to HSN codes. Per organisation (06 OQ-14).

| Column | Type | Notes |
|---|---|---|
| `hsn_code` | TEXT NOT NULL | |
| `gst_rate_bp` | INTEGER NOT NULL | CHECK 0–2800 |
| `effective_from`, `effective_to` | DATE, DATE NULL | `EXCLUDE USING gist (org_id WITH =, hsn_code WITH =, daterange(effective_from, effective_to, '[]') WITH &&)` (`btree_gist`) |

**`suppliers`**: org-wide. Licence rules are evaluated against the **receiving premises'** mode.

| Column | Type | Notes |
|---|---|---|
| `name` | TEXT NOT NULL | UNIQUE (`org_id`, `lower(name)`) |
| `gstin` | TEXT NULL | CHECK format; partial UNIQUE per organisation |
| `drug_licence_numbers` | TEXT[] NOT NULL DEFAULT `'{}'` | wholesale licence numbers |
| `licence_valid_till` | DATE NULL | |
| `address` | TEXT NULL | for the purchase register |
| `contact_name`, `contact_phone`, `contact_email` | TEXT | a business contact; never logged |
| `active` | BOOLEAN | |

Derived `licence_status`:
- `MISSING`: no licence numbers;
- `EXPIRED`: `valid_till` < today (IST);
- `VALIDITY_UNKNOWN`: numbers present, no date;
- `VALID`.

### 6.6 Stock

**`batches`** (**per premises**, D-31: the same batch number at two premises is two rows)

| Column | Type | Notes |
|---|---|---|
| `premises_id` | UUID NOT NULL | composite FK → `premises` |
| `item_id` | UUID | composite FK |
| `batch_no` | TEXT NOT NULL | normalised |
| `expiry_date` | DATE NOT NULL | `EXP 03/2027` → `2027-03-31` (§11.3) |
| `expiry_as_printed` | TEXT NULL | exactly as printed |
| `mfg_date` | DATE NULL | CHECK `mfg_date <= expiry_date` |
| `mrp_paise` | BIGINT NOT NULL | CHECK > 0; the MRP printed on the pack |
| `mrp_unit_id` | UUID NOT NULL | FK (`org_id`, `item_id`, `mrp_unit_id`) → `item_units`: the pack that MRP is for |
| `manufacturer_name_snapshot`, `manufacturer_address_snapshot` | TEXT | from the first receipt |
| `seq` | BIGINT GENERATED ALWAYS AS IDENTITY | the "earliest receipt" FEFO tie-break |

UNIQUE (`org_id`, `premises_id`, `item_id`, `batch_no`, `expiry_date`), and UNIQUE (`org_id`, `premises_id`, `item_id`, `id`) for the FKs in §2.6.

**Cost and supplier are not on the batch.** One batch can arrive on several GRNs at different rates and from different suppliers, so they live on `goods_receipt_lines`. A receipt whose MRP differs from the batch's MRP is rejected with `BATCH_MRP_MISMATCH` (06 OQ-15).

**`stock_movements`** (the append-only ledger)

| Column | Type | Constraints |
|---|---|---|
| `id` | UUID | PK (`org_id`, `id`) |
| `seq` | BIGINT GENERATED ALWAYS AS IDENTITY | UNIQUE (`org_id`, `seq`); never returned by the API (§2.6) |
| `premises_id` | UUID NOT NULL | the premises of the location (D-31) |
| `item_id` | UUID NOT NULL | composite FK → `items` |
| `batch_id` | UUID NULL | composite FK (`org_id`, `premises_id`, `item_id`, `batch_id`) → `batches`; NULL **iff** the item is untracked (trigger) |
| `location_id` | UUID NOT NULL | composite FK (`org_id`, `premises_id`, `location_id`) → `stock_locations` |
| `movement_type` | TEXT NOT NULL | CHECK in the 12 types (§7.1) |
| `qty_delta` | INTEGER NOT NULL | CHECK `<> 0`; a sign CHECK per type |
| `reference_type`, `reference_id` | TEXT, UUID NOT NULL | the source-document line (§7.1) |
| `reason_code` | TEXT NULL | CHECK NOT NULL for `EXPIRY_WRITEOFF`, `DAMAGE_WRITEOFF`, `STOCKTAKE_ADJUSTMENT`, `SUPPLIER_RETURN`, `REVERSAL` |
| `note` | TEXT NULL | CHECK `reason_code <> 'OTHER' OR note IS NOT NULL`; ≤ 500 characters |
| `actor_staff_id`, `actor_label` | UUID NOT NULL (composite FK → `staff_users`), TEXT NOT NULL | the person, plus a name snapshot |
| `occurred_at` | TIMESTAMPTZ NOT NULL | the **actual** time; equal to `recorded_at` unless backdated (§11.4) |
| `recorded_at` | TIMESTAMPTZ NOT NULL DEFAULT `now()` | |
| `reverses_movement_id` | UUID NULL | composite FK → `stock_movements`; **UNIQUE (`org_id`, `reverses_movement_id`)**; CHECK `(movement_type = 'REVERSAL') = (reverses_movement_id IS NOT NULL)` |

More CHECKs:
- `occurred_at <= recorded_at + interval '2 minutes'` (no future dating);
- `recorded_at - occurred_at <= interval '7 days'` (the hard cap).

Further rules:
- **Natural-key UNIQUE (the DB-level double-post guard):** (`org_id`, `reference_type`, `reference_id`, `movement_type`) WHERE `movement_type <> 'REVERSAL'`.
- **Indexes:**
  - (`org_id`, `item_id`, `occurred_at` DESC);
  - (`org_id`, `batch_id`);
  - (`org_id`, `occurred_at`);
  - (`org_id`, `reference_type`, `reference_id`).
- **Ordering:** every as-of computation orders by (`occurred_at`, `seq`).
- **No per-movement idempotency key.** One request creates many movements, so idempotency is per request (§12.2), and the natural key guarantees no double posting.

**`stock_balances`** (a cache, trigger-maintained and rebuildable)

| Column | Type | Constraints |
|---|---|---|
| `premises_id`, `item_id`, `batch_id` (NULL = untracked), `location_id` | UUID | UNIQUE **NULLS NOT DISTINCT** (`org_id`, `premises_id`, `item_id`, `batch_id`, `location_id`) (PG ≥ 15); the same composite FKs as the movements |
| `on_hand` | INTEGER NOT NULL | **CHECK (`on_hand >= 0`)** |
| `last_movement_seq` | BIGINT NOT NULL | |
| `updated_at` | TIMESTAMPTZ | |

A row stays when it reaches 0; it is never deleted.

### 6.7 Documents

**The shared pattern:**
- Lines carry their header's `premises_id` and reference the header with (`org_id`, `premises_id`, header id); `line_no` is UNIQUE (`org_id`, header id, `line_no`).
- **Once a document is posted, it and its lines are immutable,** except `status → REVERSED`, which needs a matching `stock_reversals` row (trigger).
- **Every movement-producing header carries:**
  - `premises_id` and `location_id`, with a composite FK (`org_id`, `premises_id`, `location_id`) → `stock_locations`, so the location is guaranteed to be in that premises;
  - `occurred_at` and `recorded_at`.

**Backdatable headers** (`dispenses`, `procedure_uses`, `patient_returns`, `goods_receipts`) additionally carry:
- `backdate_reason_code` and `backdate_note`;
- `reason_after_minutes_snapshot` (the organisation's threshold at entry);
- on dispenses and procedure uses only, `scheduled_entry_max_minutes_snapshot`.

With these CHECKs:
- `backdate_reason_code IN ('SYSTEM_UNAVAILABLE','PAPER_RECORD_ENTERED_LATE','STOCK_USED_BEFORE_INVOICE_KEYED','OTHER')`
- `recorded_at - occurred_at <= make_interval(mins => reason_after_minutes_snapshot) OR backdate_reason_code IS NOT NULL`
- `backdate_reason_code <> 'OTHER' OR backdate_note IS NOT NULL`

The threshold is per-organisation data (D-12), so it is snapshotted on the row and the CHECK stays a pure row check.

**`goods_receipts`**
- **Columns:** `supplier_id`, `premises_id`, `location_id`, `invoice_no TEXT NOT NULL`, `invoice_date DATE NOT NULL`, `invoice_total_paise BIGINT NULL`, `status` CHECK (`DRAFT`,`POSTED`,`REVERSED`,`DISCARDED`), `received_by`, `posted_at`, `posted_by`, `notes`.
- **`received_at TIMESTAMPTZ NOT NULL` (D-11):** when the goods physically arrived.
  - It defaults to posting time, and it is the `occurred_at` of every `RECEIPT` movement of the GRN.
  - It **may be backdated** under the same window, tier and reason rules as a dispense (§11.4), with CHECK `ist_date(received_at) >= invoice_date`.
  - This unblocks the commonest small-clinic flow: stock used before the invoice is keyed in. The receipt is entered later with the real arrival time, so earlier (backdated) dispenses can draw on it.
- **Supplier snapshot at posting:** `supplier_name`, `_gstin`, `_address`, `_licence_numbers`, `_licence_valid_till`. The purchase register shows what was true then.
- Partial UNIQUE (`org_id`, `supplier_id`, `lower(invoice_no)`) WHERE `POSTED` → `DUPLICATE_INVOICE`.

**`goods_receipt_lines`**
- **Columns:**
  - `line_no`, `item_id`;
  - `purchase_unit_id` (FK to the item's units), `base_units_per_unit_snapshot`;
  - `qty INTEGER > 0` (purchase units), `free_qty INTEGER ≥ 0`;
  - `batch_no`, `expiry_date`, `expiry_as_printed`, `mfg_date`;
  - `mrp_paise`, `mrp_unit_id`;
  - `purchase_rate_paise ≥ 0` (per purchase unit, pre-tax), `discount_paise ≥ 0`, `gst_rate_bp`;
  - `manufacturer_name_snapshot`, `manufacturer_address_snapshot`;
  - `raw_scan_payload NULL` (Phase 2);
  - `batch_id` (resolved at posting).
- Each line produces one `RECEIPT` of `(qty + free_qty) × factor` base units.

**`dispenses`**

| Column | Notes |
|---|---|
| `sale_type` | CHECK (`PATIENT`,`WALK_IN`); `WALK_IN` is Phase 2 (`LICENSED_PHARMACY`) |
| `mode_snapshot` | the **premises'** mode as of `occurred_at`: the legal basis of the supply |
| `patient_id` | composite FK → `patients`; NULL only for `WALK_IN` |
| `walk_in_name`, `walk_in_address` | Phase 2; CHECK present iff `WALK_IN` |
| `prescriber_id` | composite FK → `prescribers` |
| `prescriber_kind_snapshot` | `INTERNAL` / `EXTERNAL` at supply |
| `prescription_id` | NULL; composite FK → `prescriptions`. It must be `ACTIVE`, for the same patient and the same prescriber, and dated on or before the supply (MR-21). |
| `premises_id`, `location_id`, `occurred_at`, `recorded_at`, backdate fields | the shared pattern |
| `status` | CHECK (`COMPLETED`,`REVERSED`) |
| `dispensed_by_staff_id`, `dispensed_by_label` | the actor |
| `pharmacist_user_id`, `pharmacist_registration_no_snapshot`, `retail_licence_numbers_snapshot` | Phase 2 |
| **register snapshot** | `prescriber_name_snapshot`, `prescriber_registration_no_snapshot`, `prescriber_council_snapshot`, `prescriber_address_snapshot` (an `INTERNAL` prescriber without an address takes the premises' address), `patient_name_snapshot`, plus the configured extras (`patient_address_snapshot`, `patient_age_snapshot`, `patient_dob_snapshot`), and `prescription_serial_snapshot`. Filled **only when a line is H1, X or NDPS**, which keeps PHI duplication to what the register needs. Later edits to the patient or prescriber do not rewrite the register (06 OQ-11). |

DB CHECKs:
- `mode_snapshot <> 'CONSUMABLES_ONLY'`;
- `mode_snapshot <> 'RMP_OWN_PATIENTS' OR (sale_type = 'PATIENT' AND patient_id IS NOT NULL AND prescriber_kind_snapshot = 'INTERNAL')`.

**`dispense_lines`**

| Column | Notes |
|---|---|
| `line_no`, `item_id`, `unit_id`, `base_units_per_unit_snapshot` | |
| `prescription_line_id` | NULL; composite FK (`org_id`, `prescription_id`, `prescription_line_id`) → `prescription_lines`, using a copy of the header's `prescription_id` held on the line. A trigger checks that copy equals the header's. Required for an MR-18 item. |
| `qty_entered NUMERIC(12,3) > 0`, `qty_base INTEGER > 0` | CHECK `qty_entered * base_units_per_unit_snapshot = qty_base` (the DB-level whole-base-units check) |
| `item_name_snapshot`, `strength_snapshot`, `schedule_flags_snapshot TEXT[]`, `requires_prescription_snapshot BOOLEAN` | the register and audit reflect the flags in force at supply |
| `substituted_for_item_id`, `substitution_reason`, `substituted_by` | CHECK all three or none. Substitution is always an explicit human action. It is required when the line's item differs from its prescription line's `item_id`. |
| `unit_price_paise NULL`, `gross_paise`, `discount_paise ≥ 0`, `net_paise`, `gst_rate_bp NULL` | the price snapshot (§11.2); a NULL price means the line was not priced at dispense |
| `days_supply INTEGER NULL` | CHECK > 0; typed by staff from the prescription, never computed |

**`dispense_allocations`**: `premises_id`, `dispense_line_id`, `batch_id` (NULL if untracked), `qty_base > 0`, `selection` CHECK (`FEFO`,`MANUAL`), `mrp_paise_snapshot`, `mrp_pack_base_units_snapshot`. Each allocation produces exactly one `DISPENSE` movement (`reference_type = 'DISPENSE_ALLOCATION'`). Its §2.6 FKs include `premises_id`, so an allocation can only name a batch of the dispense's own premises.

**`procedure_uses`** / **`procedure_use_lines`** / **`procedure_use_allocations`**
- **Header:**
  - `patient_id NULL`, `procedure_type_id NULL`, `performing_prescriber_id NULL` (an `INTERNAL` prescriber) — all composite FKs;
  - `procedure_note`, `recorded_by`;
  - the shared pattern and backdate fields.
- **Lines** are as dispense lines, without price or prescription link.
- **Allocations** are as dispense allocations (with `premises_id`), plus:
  - `opened_container_id UUID NULL` (P1-C; composite FK with `premises_id`);
  - `lapse_override_reason TEXT NULL` and `lapse_override_by_staff_id UUID NULL` (P1-C, D-16). These are allowed only under `opened_container_lapse_policy = 'DOCTOR_OVERRIDE'`, only from a prescriber-linked session, and both or neither (CHECK).
- **Movement type** `PROCEDURE_USE`.
- **Why Phase 1:** `CONSUMABLES_ONLY` has no other consumption path. Templates are Phase 2.

**`patient_returns`** / **`patient_return_lines`**
- **Header:** `dispense_id`, with FK (`org_id`, `premises_id`, `dispense_id`) → `dispenses`, so a return is received at the premises that dispensed (§2.6); the shared pattern, backdate fields, `received_by`, `reason_code NULL`, `note`.
- **Lines:** `dispense_allocation_id` (composite FK), `qty_base > 0`, `disposition` CHECK (`RESTOCK`,`DISCARD`), `discard_reason_code` (required for `DISCARD`).

**`supplier_returns`** / **`supplier_return_lines`**
- **Header:** `supplier_id`, the shared pattern, `credit_note_no NULL`, a supplier snapshot, `returned_by`.
- **Lines:** `item_id`, `batch_id`, `qty_base > 0`, `reason_code` CHECK (`EXPIRED`,`NEAR_EXPIRY`,`DAMAGED`,`RECALL`,`EXCESS`,`WRONG_ITEM`), `goods_receipt_line_id NULL`.

**`stock_adjustments`** / **`stock_adjustment_lines`**
- **Header:** `kind` CHECK (`EXPIRY_WRITEOFF`,`DAMAGE_WRITEOFF`,`STOCKTAKE_ADJUSTMENT`,`OPENING_BALANCE`), the shared pattern.
- **Lines:** `item_id`, `batch_id`, `qty_delta` (sign per kind), `reason_code NOT NULL`, `note`, `opened_container_id NULL` (P1-C, container wastage).
- An `OPENING_BALANCE` line, or a `STOCKTAKE_ADJUSTMENT` line with reason `FOUND`, may create its batch.

**`stock_reversals`**

| Column | Notes |
|---|---|
| `document_type` | CHECK (`GOODS_RECEIPT`,`DISPENSE`,`PROCEDURE_USE`,`PATIENT_RETURN`,`SUPPLIER_RETURN`,`STOCK_ADJUSTMENT`,`STOCK_IMPORT`) |
| `document_id` | **UNIQUE (`org_id`, `document_type`, `document_id`)**: a document is reversed at most once |
| `reason_code` | NOT NULL; CHECK (`DATA_ENTRY_ERROR`,`WRONG_PATIENT`,`WRONG_ITEM`,`DUPLICATE_ENTRY`,`NOT_HANDED_OVER`,`OTHER`) |
| `note`, `reversed_by`, `reversed_at` | `note` required when the reason is `OTHER` |

**`opened_containers`** (P1-C): multi-dose containers, e.g. a reconstituted toxin vial.

| Column | Type | Notes |
|---|---|---|
| `premises_id`, `location_id`, `item_id`, `batch_id` | UUID | composite FKs including `premises_id` (§2.6) |
| `container_base_units` | INTEGER NOT NULL | a snapshot of the container unit's factor (e.g. 100) |
| `opened_at`, `opened_by_staff_id` | TIMESTAMPTZ, UUID | |
| `discard_after` | TIMESTAMPTZ NOT NULL | `opened_at + in_use_hours`, fixed at opening |
| `status` | TEXT NOT NULL | CHECK (`OPEN`,`EXHAUSTED`,`DISCARDED`) |
| `closed_at`, `closed_by`, `close_reason` | | `close_reason` CHECK (`EXHAUSTED`,`LAPSED`,`EARLY_DISCARD`) |

- **Remaining units** = `container_base_units` − Σ draws on non-reversed procedure uses − wastage. That is one table plus a wastage write-off, as decided; the ledger shape is unchanged.
- **Units never go back into a discarded vial (D-20).** When a procedure use that drew from a container is reversed after the container was `DISCARDED`, the reversal is **automatically paired** with a `DAMAGE_WRITEOFF` of the same quantity, linked to that container. Its reason is `OPENED_CONTAINER_LAPSED`, or `DAMAGED` for an early discard. The record then says what really happened (not used on the patient, but still gone), and the net effect on stock is zero.

### 6.8 Platform

- **`idempotency_keys`**: PK (`org_id`, `key`).
  - Columns: `key TEXT` (8–128 characters), `actor_staff_id`, `method_path`, `request_sha256`, `response_status`, `resource_type`, `resource_id`, `created_at`.
  - **No response body is stored.** A replay re-reads the resource, so no second copy of patient data exists.
  - Purged after 7 days.
- **`outbox_events`**:
  - `event_type` CHECK (`stock.low`,`batch.near_expiry`,`batch.expired`,`dispense.completed`,`ledger.drift_detected`,`container.lapsed`);
  - `aggregate_type`, `aggregate_id`;
  - `payload JSONB`: **ids and integers only** — no names, no phone numbers, no item-plus-patient pairs;
  - `dedupe_key`, UNIQUE (`org_id`, `dedupe_key`);
  - `occurred_at`, `published_at NULL`, `attempts`, `last_error`.
- **`ledger_reconciliation_runs`**: `run_date_ist`, `started_at`, `finished_at`, `balance_rows_checked`, `drift_count`, `drift JSONB` (ids and integers), `status`. UNIQUE (`org_id`, `run_date_ist`).
- **Register exports are audited** in `audit_log`: action `register.exported`, detail `{register, format, count, from, to}`, `entity_id` = the premises. An export of patient data is a disclosure event.

### 6.9 Onboarding

- **`stock_imports`:** `location_id` (and therefore one premises), `status` CHECK (`UPLOADED`,`VALIDATED`,`COMMITTED`,`ABANDONED`,`REVERSED`), `adapter`, `file_name`, `file_sha256`, `row_count`, `uploaded_by`, `validated_at`, `committed_at`, `committed_by`. Partial UNIQUE (`org_id`, `file_sha256`) WHERE `COMMITTED`.
- **`stock_import_rows`:**
  - `row_no`;
  - `raw JSONB`: stock columns only. The adapter drops unknown columns, so an export carrying patient data cannot smuggle it in;
  - the parsed fields;
  - `match_status` CHECK (`UNMATCHED`,`SUGGESTED`,`CONFIRMED_MASTER`,`CONFIRMED_EXISTING_ITEM`,`CUSTOM`,`SKIPPED`);
  - `master_candidates JSONB` (≤ 5 `{masterId, score}`), `matched_master_id`, `matched_item_id`, `confirmed_by`;
  - `validation_status` (`OK`,`WARN`,`ERROR`), `issues JSONB` (`[{code, field}]`).
- **`master_correction_requests`:** `master_id`, `field`, `current_value`, `proposed_value`, `note`, `submitted_by`, `status` (`OPEN`,`ACCEPTED`,`REJECTED`), `reviewed_by`, `reviewed_at`, `review_note`. The curator reads and closes them through the `curation_*` policies (§2.4).

### 6.10 Phase 2 and 3 (sketch)

- **`stock_transfers` (+ lines):**
  - **Within a premises** (store → procedure room → `QUARANTINE`): allowed, expired stock included.
  - **Between premises in the same state (D-19):** **off by default.** Allowed only:
    - when `intra_state_transfers_enabled` is on for the organisation, after the clinic's CA signs off;
    - between premises with the **same GSTIN** and the **same dispensing mode** (a DB trigger on the transfer header);
    - always with a transfer document.

    Under one GSTIN this is generally an internal movement for GST, but drug licences are per premises. Batches are per premises (§2.6), so the move is `TRANSFER_OUT` from the source premises' batch row and `TRANSFER_IN` to the destination's row with the same batch number and expiry (created if needed).
  - **Between premises in different states: blocked,** by a DB trigger comparing `premises.state_code`. A move from a branch in one state to a branch in another is a GST supply between distinct registrations and a licensing event, not a stock move. **No setting unblocks it;** that needs its own spec for GST stock-transfer documents.
  - Opened containers are never transferred.
- **Stock takes:** `stock_takes` (+ lines). A second user approves above a value threshold; DB CHECK `approved_by <> counted_by`.
- **Other tables:**
  - `purchase_orders`;
  - `procedure_consumption_templates` (procedure type → expected items, with variance);
  - `unfulfilled_requests`;
  - `label_templates` (fields to be confirmed against the current Drugs Rules text).
- **Per premises:** reorder levels and rack locations.
- **`LICENSED_PHARMACY`:** walk-in sales, `EXTERNAL` prescribers, the pharmacist on duty.

---

## 7. Ledger: movement types and invariants

### 7.1 Movement types (the expired-stock rule, D-4)

**Rule (D-4):** taking stock out of an expired batch for use is hard-blocked. **Corrections are never blocked,** because blocking a correction locks in wrong history.

| Type | Sign | `reference_type` | Reason required | On an **expired** batch | Backdatable |
|---|---|---|---|---|---|
| `OPENING_BALANCE` | + | `STOCK_IMPORT_ROW`, `STOCK_ADJUSTMENT_LINE` | — | allowed, and **posted to the premises' `QUARANTINE` location** (D-14) | no |
| `RECEIPT` | + | `GOODS_RECEIPT_LINE` | — | **blocked** (expired goods are not received) | **yes, via `received_at`** (D-11), never before the invoice date |
| `DISPENSE` | − | `DISPENSE_ALLOCATION` | — | **blocked** | yes |
| `PROCEDURE_USE` | − | `PROCEDURE_USE_ALLOCATION` | — | **blocked** | yes |
| `PATIENT_RETURN` | + | `PATIENT_RETURN_LINE` | — | allowed (the stock stays non-dispensable) | yes |
| `SUPPLIER_RETURN` | − | `SUPPLIER_RETURN_LINE` | ✓ | allowed | no |
| `EXPIRY_WRITEOFF` | − | `STOCK_ADJUSTMENT_LINE`, `PATIENT_RETURN_LINE` | ✓ | allowed, and **only** on an expired batch (it classifies; it does not block) | no |
| `DAMAGE_WRITEOFF` | − | `STOCK_ADJUSTMENT_LINE`, `PATIENT_RETURN_LINE` | ✓ | allowed | no |
| `STOCKTAKE_ADJUSTMENT` | ± | `STOCK_ADJUSTMENT_LINE` (+ `STOCK_TAKE_LINE`, Phase 2) | ✓ | allowed | no |
| `TRANSFER_OUT` / `TRANSFER_IN` (Phase 2) | − / + | `STOCK_TRANSFER_LINE` | — | allowed within a premises; inter-state always blocked | no |
| `REVERSAL` | −orig | `STOCK_REVERSAL` | ✓ | allowed | no (always now) |

**"Expired"** means the batch's `expiry_date` is earlier than the IST date of **`occurred_at`**. A backdated dispense of a batch that was valid on the day it was actually handed over is allowed (§11.4). H1, X and NDPS lines are the exception: they have their own short entry limit (D-22).

**Out of a `QUARANTINE` location,** only `EXPIRY_WRITEOFF`, `DAMAGE_WRITEOFF`, `SUPPLIER_RETURN` and the `REVERSAL` of the movement that put the stock there are allowed (L-20). Count corrections on expired stock elsewhere stay allowed (founder, accepted as written).

**Reason codes** (a catalogue in code; the DB enforces NOT NULL and `OTHER` ⇒ note):
- `DAMAGE_WRITEOFF`: `DAMAGED`, `BROKEN_OR_SPILLED`, `COLD_CHAIN_BREACH`, `CONTAMINATED`, `LOST`, `THEFT_SUSPECTED`, `RETURN_NOT_RESALEABLE`, `OPENED_CONTAINER_LAPSED` (P1-C), `OTHER`
- `EXPIRY_WRITEOFF`: `EXPIRED`
- `STOCKTAKE_ADJUSTMENT`: `COUNT_CORRECTION`, `FOUND`, `DATA_ENTRY_ERROR`, `OTHER`
- `SUPPLIER_RETURN`: as the line's reason
- `REVERSAL`: as `stock_reversals.reason_code`

### 7.2 Invariants

| ID | Invariant | Enforced by |
|---|---|---|
| L-1 | No UPDATE or DELETE on `stock_movements`, by any role | **trigger**; the app role also lacks UPDATE, DELETE and TRUNCATE privileges |
| L-2 | `stock_balances.on_hand = Σ qty_delta` per (item, batch, location) | **trigger** in the same transaction; nightly reconciliation |
| L-3 | On-hand is never negative now | **CHECK** on `stock_balances`; allocation under row locks |
| L-3b | For a backdated movement, the running balance of its key (ordered by `occurred_at`, `seq`) never drops below zero from `occurred_at` onward, so a backdated draw cannot use stock that arrived later | service check under the balance lock; **AFTER INSERT trigger** backstop for backdated rows |
| L-4 | Sign matches the movement type | **CHECK** |
| L-5 | Reason present where required; `OTHER` ⇒ note | **CHECK** |
| L-6 | `batch_id IS NULL` ⇔ the item is untracked | **trigger** |
| L-7 | The §7.1 expired matrix holds on the IST date of `occurred_at` | **trigger** + service pre-check |
| L-8 | A reversal mirrors its original exactly (same keys, `−qty`, original not a `REVERSAL`); at most one reversal per movement | **trigger** + UNIQUE |
| L-9 | A document line posts each movement type at most once | **UNIQUE** natural key |
| L-10 | A document is reversed at most once | **UNIQUE** on `stock_reversals` |
| L-11 | No row references another tenant's row, and no unique constraint spans tenants | **composite FKs** starting with `org_id` everywhere; `org_id` in every unique constraint; RLS (§2.6) |
| L-12 | Posted documents and lines are immutable except `status → REVERSED` | **trigger** |
| L-13 | Unit factors are immutable; item identity is frozen after the first movement | **triggers** |
| L-14 | Σ non-reversed returns ≤ dispensed, per allocation | service under `FOR UPDATE` on the dispense; property test |
| L-15 | Ledger rows are kept ≥ 3 years; no hard-delete path exists | L-1 + FK `RESTRICT` + no DELETE grant + no DELETE route for any posted document |
| L-16 | The app refuses to serve unless the DB enforcement objects and the role conditions hold | startup and readiness self-check (§2.5) |
| L-17 | Every table with `org_id` has RLS enabled **and forced**, with the tenant policy and no unreviewed policy | migration test + self-check |
| L-18 (P1-C) | Draws from a container ≤ its size; no draw after `discard_after`, nor from a container that is not `OPEN` | service under `FOR UPDATE` on the container + **trigger** on `procedure_use_allocations` |
| L-19 (Phase 2) | No transfer between premises whose `state_code` differs. A same-state transfer needs the organisation setting, the same GSTIN and the same mode. | **trigger** on transfer lines |
| L-20 | Stock leaves a `QUARANTINE` location only as `EXPIRY_WRITEOFF`, `DAMAGE_WRITEOFF`, `SUPPLIER_RETURN`, or the `REVERSAL` of a movement into it | **trigger** (`stock_movements_validate`) |
| L-21 | A dispense or procedure use with any H1, X or NDPS line has `recorded_at − occurred_at ≤ scheduled_entry_max_minutes_snapshot` (default 30 min, D-22). No reason or tier extends it. | **trigger** on line insert, comparing the header's lag with the line's `schedule_flags_snapshot`; service pre-check |
| L-22 | `goods_receipts.received_at` is on or after `invoice_date` (IST), and within the actor's backdating tier | **CHECK** (the date) + service (the tier) |
| L-23 (P1-C) | A draw from a lapsed container exists only with an override reason and a prescriber-linked actor, and only under the `DOCTOR_OVERRIDE` policy | **CHECK** (both or neither) + **trigger** (the policy and the prescriber link, at insert) |
| L-24 | For an MR-18 line, Σ non-reversed `qty_base` dispensed against one prescription line ≤ its `qty_base_prescribed` | service under `FOR UPDATE` on the prescription line; property test (06b DP-12) |
| L-25 | A dispense line's prescription line belongs to the header's prescription | composite FK + **trigger** |
| L-26 | No document, line, allocation, movement, balance or container references a batch or location of another premises | **composite FKs** including `premises_id` (§2.6) |
| L-27 | A merge never changes a document or ledger row; patient identity is resolved at read time | no UPDATE path (L-12, L-1) + `patient_merges` triggers (§6.2) |

### 7.3 DB enforcement (pseudo-SQL; the final form is in the PR)

```sql
-- L-1 append-only (the same trigger on audit_log and every *_history table)
CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only (% blocked)', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'P0001', HINT = 'LEDGER_APPEND_ONLY'; END $$;
CREATE TRIGGER stock_movements_append_only BEFORE UPDATE OR DELETE ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- L-6, L-7, L-8, L-20
CREATE FUNCTION stock_movements_validate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE exp DATE; tracked BOOLEAN; orig stock_movements%ROWTYPE;
BEGIN
  SELECT track_batches INTO tracked FROM items
   WHERE org_id = NEW.org_id AND id = NEW.item_id;
  IF tracked <> (NEW.batch_id IS NOT NULL) THEN
    RAISE EXCEPTION 'batch/tracking mismatch' USING HINT = 'BATCH_TRACKING_MISMATCH'; END IF;
  IF NEW.batch_id IS NOT NULL THEN
    SELECT expiry_date INTO exp FROM batches WHERE org_id = NEW.org_id AND id = NEW.batch_id;
    IF exp < (NEW.occurred_at AT TIME ZONE 'Asia/Kolkata')::date THEN
      IF NEW.movement_type IN ('DISPENSE','PROCEDURE_USE','RECEIPT') THEN
        RAISE EXCEPTION 'batch expired' USING HINT = 'BATCH_EXPIRED'; END IF;
    ELSIF NEW.movement_type = 'EXPIRY_WRITEOFF' THEN
      RAISE EXCEPTION 'batch not expired' USING HINT = 'EXPIRY_WRITEOFF_NOT_EXPIRED';
    END IF;
  END IF;
  IF NEW.movement_type = 'REVERSAL' THEN
    SELECT * INTO orig FROM stock_movements
     WHERE org_id = NEW.org_id AND id = NEW.reverses_movement_id;
    IF orig.movement_type = 'REVERSAL' OR orig.item_id <> NEW.item_id
       OR orig.batch_id IS DISTINCT FROM NEW.batch_id OR orig.location_id <> NEW.location_id
       OR NEW.qty_delta <> -orig.qty_delta THEN
      RAISE EXCEPTION 'reversal does not mirror original' USING HINT = 'REVERSAL_MISMATCH';
    END IF;
  END IF;
  -- L-20: quarantine is a one-way door to disposal
  IF NEW.qty_delta < 0
     AND (SELECT kind FROM stock_locations WHERE org_id = NEW.org_id AND id = NEW.location_id) = 'QUARANTINE'
     AND NEW.movement_type NOT IN ('EXPIRY_WRITEOFF','DAMAGE_WRITEOFF','SUPPLIER_RETURN','REVERSAL') THEN
    RAISE EXCEPTION 'quarantined stock can only be written off or returned' USING HINT = 'QUARANTINED';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER stock_movements_validate BEFORE INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_validate();

-- L-2, L-3: the cache, maintained in the same transaction
CREATE FUNCTION stock_movements_apply() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO stock_balances (org_id, premises_id, item_id, batch_id, location_id, on_hand, last_movement_seq)
  VALUES (NEW.org_id, NEW.premises_id, NEW.item_id, NEW.batch_id, NEW.location_id, NEW.qty_delta, NEW.seq)
  ON CONFLICT (org_id, premises_id, item_id, batch_id, location_id) DO UPDATE
    SET on_hand = stock_balances.on_hand + EXCLUDED.on_hand,
        last_movement_seq = EXCLUDED.last_movement_seq, updated_at = now();
  RETURN NULL;   -- CHECK (on_hand >= 0) fires here if anything slipped through
END $$;
CREATE TRIGGER stock_movements_apply AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_apply();

-- L-3b: backdated rows only (bounded cost)
CREATE FUNCTION stock_movements_asof_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.recorded_at - NEW.occurred_at > interval '2 minutes' AND EXISTS (
     SELECT 1 FROM (
       SELECT occurred_at, sum(qty_delta) OVER (ORDER BY occurred_at, seq) AS running
         FROM stock_movements
        WHERE org_id = NEW.org_id AND item_id = NEW.item_id
          AND batch_id IS NOT DISTINCT FROM NEW.batch_id AND location_id = NEW.location_id) r
      WHERE r.occurred_at >= NEW.occurred_at AND r.running < 0) THEN
    RAISE EXCEPTION 'backdated movement makes history negative' USING HINT = 'INSUFFICIENT_STOCK_AS_OF';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER stock_movements_asof_check AFTER INSERT ON stock_movements
  FOR EACH ROW EXECUTE FUNCTION stock_movements_asof_check();
```

- **`SECURITY DEFINER` with forced RLS.** The function runs as its owner (the migrator) with a pinned `search_path`. Because RLS is **forced**, the owner is still subject to the tenant policy, and the transaction's `app.org_id` is still set inside the trigger. So the cache write passes `WITH CHECK` only for the same tenant, and the app role needs no write privilege on `stock_balances`.
- **TRUNCATE** is not trigger-blocked, so the harness can reset tables as the migrator. The app role never holds TRUNCATE (06b DL-05 runs as the app role).
- **Error mapping.** DB exceptions carry a stable `HINT`, which the service maps to 409/422 codes. A backstop firing is **never a 500**. It is logged as `ledger_backstop_fired` (ids and hint only), and it means a service pre-check missed.

### 7.4 Balance cache and reconciliation

- **Why a trigger-maintained cache.** Allocation needs fast, *lockable* per-batch rows, and `CHECK (on_hand >= 0)` turns "never negative" into a DB guarantee. Maintaining the cache in the trigger means no code path, manual SQL included, can change the ledger without the cache.
- **Rebuild.** `rebuild_balances(org_id)` is an ops script, run as the migrator inside `withTenant`. It:
  - locks the tenant's balance rows;
  - recomputes `Σ qty_delta` per key;
  - writes corrections;
  - records a reconciliation run.

  06b DP-06 proves `rebuild(truncated cache) == cache`.
- **Reconciliation** (nightly, 02:30 IST, per organisation) compares the cache with the ledger. Any drift produces a run row, a `ledger.drift_detected` event and a log line (ids and counts only). Drift is **never auto-corrected**: a human runs the rebuild after investigating.

---

## 8. Allocation (a pure function)

```
allocate(candidates: BatchStock[], qtyBase: int, asOf: date) -> Allocation[] | Insufficient
  BatchStock   = { batchId, expiryDate, batchSeq, available }    // one per batch at the location
  Insufficient = { availableNonExpired, expiredOnHand }
```

1. **Eligible:** `available > 0` and `expiryDate ≥ asOf`, where `asOf` is the IST date of `occurred_at`. A batch is dispensable through the end of its expiry date (§11.3).
2. **Order** by (`expiryDate`, `batchSeq`, `batchId`): earliest expiry, then earliest receipt, then a stable id.
3. **Greedy:** take from each batch in order. The result may split across batches.
4. **Short:** return `Insufficient` with both totals, so the UI can say "15 more on the shelf are expired".
5. **Untracked items** have one pseudo-candidate (`batchId = null`, no expiry).
6. **Several lines for one item** in a document allocate in line order against a running snapshot, so they share one pool.
7. **No I/O and no clock read.** The result is deterministic for the same inputs (06b DP-04).

**What `available` means** (computed by the service under the balance locks, before calling `allocate`):
- normally, the batch's `on_hand`;
- for a **backdated** entry, the minimum running balance of the key from `occurred_at` onward (L-3b);
- for a **multi-dose item** (P1-C), sealed stock only (`on_hand − Σ remaining in OPEN containers`), when opening new containers or dispensing whole containers.

**Candidates never include a `QUARANTINE` location** (L-20). Allocation always runs against one non-quarantine location.

**Multi-dose procedure use (P1-C).**
- Draw first from `OPEN` containers of that item at that location that are not past `discard_after` (at `occurred_at`) and have units left, oldest `opened_at` first.
- For any shortfall, open new containers from sealed stock in FEFO batch order.
- **Lapsed containers:**
  - under `opened_container_lapse_policy = 'BLOCK'` (the default), they are never candidates;
  - under `DOCTOR_OVERRIDE`, they are offered only to a prescriber-linked session that sends an explicit `lapseOverride {containerId, reason}` with a signing-PIN grant. They are never chosen automatically.
- **Dispensing a multi-dose item to a patient** is allowed only in whole sealed containers: the unit must be the container unit or larger.

**Manual selection.** Staff may name the batch physically handed over, because the ledger must match the shelf for recalls.
- It passes the same eligibility check and is recorded with `selection = 'MANUAL'`.
- Picking a later-expiring batch than FEFO would shows a non-blocking warning, `NOT_FEFO`.

---

## 9. Service operations

### 9.1 The common contract for every state-changing operation

**Preconditions, in order:**
1. The verified identity (§3): actor, organisation, active session, active person on the device, permissions.
2. `stock_settings` exists (else 409 `DISPENSARY_NOT_CONFIGURED`), and `premises_settings` exists for the target premises (else 409 `PREMISES_NOT_CONFIGURED`). This applies to stock operations only.
3. The permission check (§4), then premises membership (MR-19).
4. An `Idempotency-Key` (§12.2), and a re-auth grant where §3.7 requires one.
5. The self-check has passed (§2.5).

**One `withTenant` transaction per request, all or nothing.** The lock order is global:
1. insert the idempotency key row;
2. document header rows `FOR UPDATE`, by id;
3. prescription lines `FOR UPDATE`, by id (MR-18 quantities);
4. `stock_balances` rows `FOR UPDATE`, sorted by (`item_id`, `location_id`, `batch_id` NULLS FIRST), locking every row of each (item, location) with no `on_hand` filter;
5. opened containers `FOR UPDATE`, by id (P1-C).

Movements are inserted in the same canonical order. A deadlock (`40P01`) or serialisation failure is retried at most twice (safe because of the idempotency key), then answered **503 `RETRY_LATER`**.

**Postconditions.** Movements, cache updates (trigger), outbox events, the consumed re-auth grant and any transactional audit row are written in the same transaction. The idempotency row records the status and resource id.

**Logs.** One structured line per operation (`event`, `org_id`, document id, counts, `duration_ms`). **Never** a patient name, phone number, prescription text, item name or patient↔item pair.

### 9.2 Patients, prescribers and prescriptions

| Operation | Preconditions | Effect | Failure modes |
|---|---|---|---|
| `create_patient` | `patients.edit` | patient row; phone normalised to E.164 | 422 `PHONE_FORMAT`; warning `POSSIBLE_DUPLICATE` (non-blocking) |
| `update_patient`, `archive_patient` | `patients.edit` | row update; best-effort audit `patient.updated {fields}` | 404 `PATIENT_NOT_FOUND` |
| `create_prescriber`, `update_prescriber` | `prescribers.manage` | row | 422 `PRESCRIBER_ADDRESS_REQUIRED` (`EXTERNAL`) |
| `record_prescription` | `rx.enter`; patient, prescriber and premises in the organisation; the premises in the user's membership | header + optional lines; `entered_by` = the actor | 404s; 422 `PRESCRIBED_ON_IN_FUTURE` |
| `add_prescription_lines` | `rx.enter`; status `ACTIVE` | new lines (existing lines never change once dispensed against) | 409 `PRESCRIPTION_VOID` |
| `add_prescription_image` | `rx.enter`; status `ACTIVE` | image row (sniffed MIME type, SHA-256, size) | 413 `FILE_TOO_LARGE`; 422 `UNSUPPORTED_FORMAT` |
| `verify_prescription` | `rx.verify`; the actor's `prescriber_id` = the prescription's prescriber; a signing-PIN grant (`prescription.verify`) | `verified_by_staff_id`, `verified_at`; transactional audit `prescription.verified` | 403 `not_the_prescriber`; 401 `reauth_required`; 409 `ALREADY_VERIFIED` |
| `void_prescription` | `rx.enter`; no non-reversed dispense line references it | status `VOID` with a reason; transactional audit `prescription.voided` | 409 `PRESCRIPTION_HAS_DISPENSES` |
| `list_duplicates` | `patients.merge` | pairs of current patients with the same normalised phone and similar names (§6.2), with counts of their documents; no merge is ever automatic | — |
| `merge_patients(survivorId, mergedId, reason)` | `patients.merge` + grant `patients.merge`; both patients current (not merged) and in the organisation | one `patient_merges` row; transactional audit `patient.merged {survivor_id, merged_id}`. **No document, ledger or prescription row is updated.** | 404 `PATIENT_NOT_FOUND`; 409 `PATIENT_ALREADY_MERGED`, `MERGE_CYCLE`; 422 `MERGE_SAME_PATIENT` |
| `undo_merge(mergeId)` | `patients.merge` + grant `patients.merge`; not already undone | sets `undone_*`; audit `patient.merge_undone` | 404 `MERGE_NOT_FOUND`; 409 `MERGE_ALREADY_UNDONE` |

### 9.3 Stock operations

| Operation | Preconditions (beyond §9.1) | Effect | Failure modes |
|---|---|---|---|
| `setup_dispensary` | `stock.settings`; no settings row yet | the stock settings row | 409 `ALREADY_CONFIGURED` |
| `setup_premises(premisesId, mode, licences, registerFields)` | `stock.settings` + grant `premises.legal_settings`; the premises is in the organisation | premises settings + history row + the default and quarantine locations | 404 `PREMISES_NOT_FOUND`; 422 `MODE_NOT_AVAILABLE` (`LICENSED_PHARMACY` in Phase 1); 409 `ALREADY_CONFIGURED` |
| `update_settings` / `update_premises_settings` (`If-Match`) | the version matches; the premises one needs the `premises.legal_settings` grant | row update + history row | 412 `VERSION_MISMATCH`; 422 `MODE_NOT_AVAILABLE`, `LICENCE_DATES_INVALID` |
| `create_item`, `update_item`, `add_unit`, `set_tax_rate` | `stock.items` | catalogue rows; the base unit row is created automatically | 404 `MASTER_ITEM_NOT_FOUND`; 409 `ITEM_EXISTS`, `ITEM_IDENTITY_LOCKED`; 422 `TAX_RATE_OVERLAP`, `UNIT_FACTOR_IMMUTABLE` |
| `create_grn_draft`, `update_grn_draft`, `discard_grn` | `stock.receive`; supplier, items and premises in the organisation | a DRAFT header and lines, no movements; discard → `DISCARDED` | 404 for any out-of-scope reference; 409 `GRN_NOT_DRAFT` |
| `post_grn` | DRAFT; ≥ 1 line; tracked lines have `batch_no`, `expiry_date`, `mrp_paise` and `mrp_unit_id`; **the mode rules for the GRN's premises** (MR-03, MR-04, MR-08, MR-09). If `received_at` is in the past: the backdating tier, reason and window (§11.4), and `received_at ≥ invoice_date`. | resolves or creates batches; one `RECEIPT` per line (canonical order) with `occurred_at = received_at`; supplier snapshot; `POSTED` | 422 `SUPPLIER_LICENCE_MISSING`, `MANUFACTURER_DETAILS_MISSING`, `LICENCE_REQUIRED_NDPS`, `LICENCE_REQUIRED_SCHEDULE_X`, `QTY_NOT_WHOLE_BASE_UNITS`; 409 `BATCH_EXPIRED`, `BATCH_MRP_MISMATCH`, `DUPLICATE_INVOICE`, `GRN_NOT_DRAFT`. Warnings: `SUPPLIER_LICENCE_EXPIRED`, `NEAR_EXPIRY_ON_ARRIVAL`. |
| `preview_dispense` | `stock.dispense`; the premises' mode allows dispensing | **read-only:** FEFO allocations, per-unit MRP ceilings, the remaining prescribed quantity for MR-18 lines, warnings. No locks, no writes. | the same validation errors as `dispense` |
| `dispense` | `stock.dispense` (+ `stock.backdate` / `stock.backdate_extended` if backdated, and a `stock.backdate` signing-PIN grant beyond the reason-free lag, D-33); premises membership (MR-19); **the mode rules for the premises as of `occurred_at`** (MR-01, MR-02, MR-06, MR-08, MR-09, MR-15, MR-18, MR-20, MR-21, MR-22); patient, prescriber and prescription in the organisation.<br>Each line: the item is active; the unit is of that item and dispensable; whole base units; the substitution triple is complete where needed; price ≤ MRP (§11.2). | locks; allocates; inserts the dispense, lines, allocations and `DISPENSE` movements; the register snapshot if any line is H1/X/NDPS; `stock.low` on a crossing; `dispense.completed` | 404 `PATIENT_NOT_FOUND`, `PRESCRIBER_NOT_FOUND`, `PRESCRIPTION_NOT_FOUND`, `ITEM_NOT_FOUND`, `BATCH_NOT_FOUND`, `PREMISES_NOT_FOUND`, `LOCATION_NOT_FOUND`;<br>409 `PRESCRIPTION_VOID`, `RX_QTY_EXCEEDED`, `INSUFFICIENT_STOCK` (with `details[]`), `INSUFFICIENT_STOCK_AS_OF`, `BATCH_EXPIRED` (manual pick), `MODE_FORBIDS_OPERATION`;<br>422 `PATIENT_REQUIRED`, `PATIENT_ARCHIVED`, `PATIENT_DETAILS_REQUIRED`, `PRESCRIBER_NOT_INTERNAL`, `PRESCRIBER_REGISTRATION_MISSING`, `PRESCRIPTION_PATIENT_MISMATCH`, `PRESCRIPTION_PRESCRIBER_MISMATCH`, `PRESCRIPTION_DATED_AFTER_SUPPLY`, `PRESCRIPTION_TOO_OLD`, `PRESCRIPTION_IMAGE_MISSING`, `RX_REQUIRED`, `RX_LINE_ITEM_MISMATCH`, `RX_EVIDENCE_REQUIRED`, `RX_QTY_NOT_RECORDED`, `UNIT_NOT_DISPENSABLE`, `QTY_NOT_WHOLE_BASE_UNITS`, `QTY_FORMAT`, `PRICE_ABOVE_MRP`, `DISCOUNT_EXCEEDS_GROSS`, `SUBSTITUTION_INCOMPLETE`, `ITEM_INACTIVE`, `LICENCE_REQUIRED_*`, `BACKDATE_*` |
| `record_procedure_use` | `stock.dispense` (+ `stock.backdate`); a patient link per `procedure_use_patient_link`; the premises' NDPS/X licence; under `DOCTOR_OVERRIDE`, a lapse override needs a prescriber-linked session and the `container.lapse_override` grant | as dispense, with `PROCEDURE_USE` movements and no price; for multi-dose items it draws from or opens containers (P1-C) | 422 `PATIENT_REQUIRED`, `OVERRIDE_REASON_REQUIRED`; 403 `prescriber_login_required`; 409 `CONTAINER_LAPSED`, `CONTAINER_CLOSED`; otherwise as dispense |
| `return_from_patient` | `stock.dispense` (+ `stock.backdate`); the premises' mode allows dispensing; the dispense is `COMPLETED`; each allocation belongs to it; qty ≤ allocated − Σ prior non-reversed returns (dispense row locked) | `PATIENT_RETURN` +q into the **original batch** at the return location. `DISCARD` also writes `DAMAGE_WRITEOFF` −q, or `EXPIRY_WRITEOFF` if the batch has since expired. A return does **not** give back MR-18 prescribed quantity (only a reversal does). | 404 `DISPENSE_NOT_FOUND`, `ALLOCATION_NOT_FOUND`; 409 `DISPENSE_REVERSED`, `RETURN_WRONG_PREMISES` (only the dispensing premises can receive it, §2.6); 422 `RETURN_EXCEEDS_DISPENSED` |
| `return_to_supplier` | `stock.writeoff` + grant `stock.writeoff`; supplier in the organisation; qty ≤ on hand (locked); expired batches allowed | `SUPPLIER_RETURN` movements | 404s; 409 `INSUFFICIENT_STOCK`; 422 `REASON_REQUIRED` |
| `write_off(kind, lines)` | `stock.writeoff` + grant `stock.writeoff`; a reason is mandatory; `EXPIRY_WRITEOFF` only on an expired batch; `DAMAGE_WRITEOFF` on any batch | an adjustment document + movements | 422 `REASON_REQUIRED`, `NOTE_REQUIRED`; 409 `EXPIRY_WRITEOFF_NOT_EXPIRED`, `INSUFFICIENT_STOCK` |
| `adjust_stock(lines)` | `stock.adjust` + grant `stock.adjust`; a reason is mandatory; a negative adjustment ≤ on hand; expired batches allowed (corrections); `OPENING_BALANCE` only where that (item, batch, location) has **no** prior movement | `STOCKTAKE_ADJUSTMENT` or `OPENING_BALANCE` movements | 409 `OPENING_BALANCE_NOT_ALLOWED`, `INSUFFICIENT_STOCK` |
| `reverse_document(type, id, reason, note)` | `stock.adjust` + grant `stock.reverse`; the document is in the organisation and not reversed.<br>• `DISPENSE`/`PROCEDURE_USE`: within `dispense_reversal_window_hours` of `recorded_at`.<br>• **No live dependents:** e.g. a dispense with non-reversed returns, or a GRN whose lines supplier returns reference.<br>• `STOCK_IMPORT`: only if none of its keys has a later movement. | The `stock_reversals` row (UNIQUE), then one `REVERSAL` per original movement (canonical order); status `REVERSED`.<br>• A reversed dispense gives back its MR-18 prescribed quantity.<br>• A reversed procedure use returns its drawn units to the container if it is still `OPEN`.<br>• If the container was **`DISCARDED`**, each returned draw is **paired in the same transaction** with a `DAMAGE_WRITEOFF` of the same quantity, linked to that container (D-20). Units never go back into a discarded vial as usable stock. | 404 `DOCUMENT_NOT_FOUND`; 409 `ALREADY_REVERSED`, `REVERSAL_WINDOW_CLOSED`, `DOCUMENT_HAS_DEPENDENTS`, `INSUFFICIENT_STOCK` (e.g. reversing a GRN whose stock was already used: use a supplier return or adjustment instead) |
| `open_container` (P1-C) | `stock.dispense`; a multi-dose item; sealed stock in the batch; the batch is not expired | an `opened_containers` row with `discard_after = opened_at + in_use_hours`. It also happens implicitly on the first draw. | 409 `INSUFFICIENT_STOCK`, `BATCH_EXPIRED` |
| `discard_container` (P1-C) | `stock.dispense`; the container is `OPEN` | a `DAMAGE_WRITEOFF` of the remaining units, reason `OPENED_CONTAINER_LAPSED` (past `discard_after`) or `DAMAGED`/`OTHER` with a note (early); status `DISCARDED`. A container reaching 0 remaining becomes `EXHAUSTED` automatically. | 409 `CONTAINER_CLOSED` |
| Import operations | §15 | | |
| Daily jobs | §13 | | |

**Reversal postcondition** (06b DP-03): for every key the document touched, `on_hand` after the reversal equals `on_hand` just before the document, plus every unrelated movement since.

**Low-stock emission.** Low stock is measured on **dispensable** (non-expired) on-hand **per premises**, against the item's `reorder_level`. A shelf of expired stock must not hide a shortage, and a full store at one branch must not hide an empty store at another.
- **In the transaction:** when a document's movements take an item at a premises from `≥ reorder_level` to `< reorder_level`, insert `stock.low` `{itemId, premisesId, onHandAfter, reorderLevel}`.
- **In the daily job:** when the passing of an expiry date causes the crossing, with no movement.

It is emitted once per crossing, never per movement.

---

## 10. Dispensing-mode matrix (per premises, D-6)

**How the rules apply:**
- Every rule is a server-side check; where noted, it is also a DB constraint.
- **Every rule is evaluated against the premises where the operation happens, using that premises' mode and licences as of the operation's `occurred_at`.**
- Each rule has a passing and a failing test in 06b (DM rows).

| Rule | Mode(s) | Operation | Rule | Error | Also in DB |
|---|---|---|---|---|---|
| MR-01 | RMP | dispense, preview | `sale_type = PATIENT`; `patient_id` required, a patient of the organisation, not archived. No walk-in or anonymous sale, `RETAIL_PRODUCT` items included (06 OQ-10). | missing → 422 `PATIENT_REQUIRED`; `WALK_IN` → 409 `MODE_FORBIDS_OPERATION`; another tenant's or unknown → 404 `PATIENT_NOT_FOUND`; archived → 422 `PATIENT_ARCHIVED` | CHECK on `dispenses` |
| MR-02 | RMP | dispense | the prescriber is an **active `INTERNAL`** prescriber of the organisation whose `registration_no` and `council` are set | 404 `PRESCRIBER_NOT_FOUND`; 422 `PRESCRIBER_NOT_INTERNAL`, `PRESCRIBER_REGISTRATION_MISSING` | CHECK `prescriber_kind_snapshot` |
| MR-03 | RMP | post GRN | the supplier has ≥ 1 drug licence number on file | 422 `SUPPLIER_LICENCE_MISSING`. An expired licence is the warning `SUPPLIER_LICENCE_EXPIRED`, not a block. | — |
| MR-04 | RMP | post GRN | every `MEDICINE`/`INJECTABLE` line resolves a manufacturer name **and address** (line → item → master), so the Schedule K purchase record is complete | 422 `MANUFACTURER_DETAILS_MISSING` | — |
| MR-05 | RMP | registers | the purchase register can be produced on demand, per premises, for any IST date range (§14) | — | — |
| MR-06 | CONSUMABLES_ONLY | dispense, preview, patient return | no patient dispensing at this premises, even if another premises of the organisation dispenses | 409 `MODE_FORBIDS_OPERATION` | CHECK `mode_snapshot <> 'CONSUMABLES_ONLY'` |
| MR-07 | CONSUMABLES_ONLY | GRN, procedure use, write-off, supplier return, adjustment, reversal, import | allowed; MR-03 and MR-04 do **not** apply (06 OQ-13) | — | — |
| MR-08 | all | GRN post, dispense, procedure use, opening balance | an item with `NDPS` in its effective flags needs **this premises'** `ndps_licence_no` set and `valid_till ≥` the IST date of `occurred_at` | 422 `LICENCE_REQUIRED_NDPS` | — |
| MR-09 | all | as MR-08 | `X` needs this premises' Schedule X licence, recorded and in date | 422 `LICENCE_REQUIRED_SCHEDULE_X` | — |
| MR-10 | all | write-off, supplier return, reversal | always allowed for NDPS/X items, so unlicensed stock can be got rid of | — | — |
| MR-11 | all | dispense, procedure use | expired is a hard block with **no override and no setting**: FEFO skips expired batches, and a manual pick of one fails | 409 `BATCH_EXPIRED` / `INSUFFICIENT_STOCK` (`expiredOnHandBase` in details) | trigger L-7 |
| MR-12 | LICENSED (Phase 2) | dispense | Walk-ins are allowed. H/H1/X lines need an `EXTERNAL` or `INTERNAL` prescriber with name, registration number and address, and a patient name and address. The pharmacist on duty and the licence numbers are snapshotted per sale. | 422 `PRESCRIPTION_DETAILS_REQUIRED`, `PHARMACIST_REQUIRED` | columns exist now |
| MR-13 | all, Phase 1 | settings | `LICENSED_PHARMACY` cannot be selected until Phase 2 | 422 `MODE_NOT_AVAILABLE` | — |
| MR-14 | all | dispense record | `mode_snapshot` = the premises' mode at `occurred_at` | — | CHECKs above |
| MR-15 | all | dispense, procedure use, patient return, GRN receipt | Backdating within the actor's tier (`stock.backdate`: the standard window; `stock.backdate_extended`: the extended one). Beyond `backdate_reason_after_minutes`: a reason **and a `stock.backdate` signing-PIN grant** (D-33). All rules are checked at the actual date (§11.4). | 422 `BACKDATE_REASON_REQUIRED`, `BACKDATE_WINDOW_EXCEEDED`, `OCCURRED_AT_IN_FUTURE`, `RECEIVED_BEFORE_INVOICE`; 403 `forbidden`; 401 `reauth_required` | CHECKs (§6.6, §6.7) |
| MR-16 | all, Phase 2 | transfer | No transfer between premises in different states. A same-state transfer needs the organisation setting, the same GSTIN and the same mode (D-19). | 409 `INTERSTATE_TRANSFER_BLOCKED`, `TRANSFER_NOT_ENABLED`, `TRANSFER_GSTIN_OR_MODE_MISMATCH` | trigger L-19 |
| MR-17 | all, P1-C | procedure use | No draw from a lapsed or closed container, except a recorded override by a prescriber-linked user with a signing PIN under the `DOCTOR_OVERRIDE` policy (D-16) | 409 `CONTAINER_LAPSED` / `CONTAINER_CLOSED`; 422 `OVERRIDE_REASON_REQUIRED`; 403 `prescriber_login_required`; 401 `reauth_required` | triggers L-18, L-23 |
| MR-18 | all | dispense | **(D-23, adapted to recorded prescriptions.)** Applies to a line whose item's effective flags include **Schedule X**, or whose item has **`requires_prescription`** true (D-32: the item's own flag, with the linked master's flag as a backstop until the daily job copies it). The line must:<br>• link a **prescription line** of a prescription that passes MR-21;<br>• match it: that prescription line's `item_id` is the dispensed item, or the item it substitutes for;<br>• have **evidence** behind the prescription: at least one photo, **or** verification by its own prescriber with a signing PIN;<br>• have `qty_base_prescribed` recorded on the prescription line;<br>• keep Σ non-reversed quantity already dispensed against that line, plus this line, ≤ prescribed (L-24).<br>The rule reads only data, never drug names. | 422 `RX_REQUIRED`, `RX_LINE_ITEM_MISMATCH`, `RX_EVIDENCE_REQUIRED`, `RX_QTY_NOT_RECORDED`; 409 `RX_QTY_EXCEEDED` (`{prescribedBase, alreadyDispensedBase}`) | — (service under `FOR UPDATE` on the prescription line) |
| MR-19 | all | every stock read and write | the premises is in the actor's membership, or the actor is `owner` (D-17) | 404 `PREMISES_NOT_FOUND` | — |
| MR-20 | all | dispense, procedure use | a document with any **H1, X or NDPS** line is recorded within `scheduled_entry_max_minutes` of the supply (default 30 min, D-22). No reason or tier extends it. | 422 `BACKDATE_NOT_ALLOWED_SCHEDULED` | trigger L-21 |
| MR-21 | all | dispense that links a prescription | The prescription:<br>• is `ACTIVE`;<br>• is of the same patient (compared as canonical ids after merges, §6.2), by the same prescriber as the dispense;<br>• is dated on or before the IST date of `occurred_at`;<br>• is not older than `prescription_max_age_days` on that date, if the premises sets it;<br>• has ≥ 1 image if it is a `PHOTO` record. | 404 `PRESCRIPTION_NOT_FOUND`; 409 `PRESCRIPTION_VOID`; 422 `PRESCRIPTION_PATIENT_MISMATCH`, `PRESCRIPTION_PRESCRIBER_MISMATCH`, `PRESCRIPTION_DATED_AFTER_SUPPLY`, `PRESCRIPTION_TOO_OLD`, `PRESCRIPTION_IMAGE_MISSING` | composite FKs |
| MR-22 | all | dispense with an H1 line | the patient has every field the premises' `h1_register_extra_fields` asks for (address, DOB) | 422 `PATIENT_DETAILS_REQUIRED` (`details.fields`) | — |

- **Mode changes** affect only future operations and never rewrite history (`mode_snapshot`). The history tables keep who changed what, and when. Moving a premises into RMP lists that organisation's suppliers without licences in a non-blocking report.
- **The legal summaries above come from the brief and are not independently verified.** Counsel confirms them before go-live (06 OQ-8). Putting the mode on the premises rather than the organisation is a founder decision (D-6).
- **MR-18 is a record-keeping control, not clinical advice.** The prescribed quantity is typed from the paper by a person; nothing is computed from a dose. Whether a prescription may be dispensed in parts, how old it may be, and whether a return should give quantity back are for counsel (06 OQ-32).

---

## 11. Units, pricing and time

### 11.1 Units

- **Conversion:** `qty_base = qty_entered × base_units_per_unit`, computed in integer milli-units (§5). A non-integer result → 422 `QTY_NOT_WHOLE_BASE_UNITS`. For example, 0.5 tablet is rejected, while 0.5 box of 150 = 75 tablets is accepted.
- **Wire format:** `quantity` is a JSON integer, or a decimal **string** with at most 3 decimals. A JSON floating-point number → 422 `QTY_FORMAT`.
- **Display:** base units plus the largest whole pack, e.g. "47 tablets (3 strips + 2)".

### 11.2 MRP ceiling

The MRP is printed per **MRP pack**: `M` paise for `n` base units (the batch's `mrp_paise` and the factor of its `mrp_unit_id`). A line is priced per **entered unit**: `P` paise for `f` base units.

**Rule (exact, no rounding):** for every allocation of a priced line,

```
P × n  ≤  M × f        (integer cross-multiplication; stays < 2^53 for any realistic MRP)
```

- **What it means:** exactly "price per base unit ≤ MRP per base unit".
- **Several batches:** when a line spans batches with different MRPs, each batch binds separately, so the cheapest batch's MRP caps the line.
- **A violation** → 422 `PRICE_ABOVE_MRP` with `{lineNo, batchId, maxUnitPricePaise}`.

**The one documented rounding rule:** a per-unit MRP that is *displayed or suggested* is `floor(M × f / n)` paise, rounding in the patient's favour. Validation never rounds.

**Line totals:**
- `gross_paise = qty_entered × P`, rounded half-up to the paise only when `qty_entered` is fractional;
- `0 ≤ discount_paise ≤ gross_paise`;
- `net_paise = gross_paise − discount_paise`;
- `gst_rate_bp` is snapshotted from `item_tax_rates` effective on the IST date. If none is configured it is NULL, with a warning.

**Worked examples** (06b DU-*), with an MRP of ₹45.00 per strip of 15 (`M = 4500`, `n = 15`):
- 7 tablets at ₹3.00 (`P = 300`, `f = 1`): `4500 ≤ 4500`. **OK.**
- 7 tablets at ₹3.01: `4515 > 4500`. **Rejected.**
- One strip at ₹45.00: `67500 ≤ 67500`. **OK.**
- The displayed per-tablet MRP: `floor(4500 / 15) = 300`.

### 11.3 Expiry

- **Parsing:** `MM/YYYY` → the last day of that month (`03/2027` → `2027-03-31`; `02/2028` → `2028-02-29`). A full printed date is stored as is. `expiry_as_printed` keeps the original text.
- **Dispensable** ⇔ `expiry_date ≥` the IST date of `occurred_at`. A batch is **allowed at 23:59:59 IST on its expiry date and blocked from 00:00:00 IST the next day** (= 18:30:00 UTC on the expiry date).
- **IST everywhere.** Every "today", day bucket and report period is IST. Period parameters `from`/`to` are inclusive IST dates.

### 11.4 Backdating (D-4, D-10 … D-13, D-22)

- **Which entries can be backdated:** dispense, procedure use, patient return, and a GRN's `received_at` (D-11). Everything else (write-offs, adjustments, supplier returns, reversals) is recorded at server time.
- **Reason-free lag.** A lag up to `backdate_reason_after_minutes` (per-organisation data, default **120 min**, D-12) needs nothing extra. Desks enter a visit after the patient leaves, and a prompt on every entry would teach staff to type "ok". The threshold is tuned from pilot data using the lag report (§14).
- **Beyond the reason-free lag:**
  - a **mandatory reason**: `SYSTEM_UNAVAILABLE`, `PAPER_RECORD_ENTERED_LATE`, `STOCK_USED_BEFORE_INVOICE_KEYED`, or `OTHER` with a note;
  - **a signing-PIN grant** (`stock.backdate`, D-33), so the person entering it signs for the late entry;
  - **and the actor's tier** (D-13):
    - `stock.backdate`: up to `backdate_window_hours` (default 48 h; reception, doctor, owner);
    - `stock.backdate_extended`: up to `backdate_extended_window_hours` (default 7 days; owner only).
  - The DB hard cap is 7 days. There is no future dating (a 2-minute clock-skew allowance).
- **H1, X and NDPS have their own, tighter limit** (D-22). A dispense or procedure use with any such line must be recorded within **`scheduled_entry_max_minutes`** (default **30 min**) of the supply. No reason, tier or extended window stretches it (L-21, MR-20). H1 supplies are entered at the time of supply.
- **Receipts (D-11).** `received_at` is never earlier than `invoice_date`. Backdating a receipt can only *add* stock in the past, so it can never make history negative. It is what lets an earlier backdated dispense draw on stock whose invoice was keyed later.
- **Checked against the actual date (`occurred_at`), not the entry date:**
  1. the batch was not expired on the IST date of `occurred_at`;
  2. the premises' mode and licences **as of `occurred_at`**, from the settings history;
  3. **as-of stock:** the running balance stays ≥ 0 from `occurred_at` onward (L-3b), so a backdated entry cannot use stock that arrived later than that stock's own `received_at`;
  4. the container was open and not lapsed at `occurred_at` (P1-C);
  5. the linked prescription was dated on or before `occurred_at` (MR-21).
- **Registers always show both times (D-10):** the time of supply (`occurred_at`) **and** the time recorded (`recorded_at`), plus any reason. This holds for every row, not only backdated ones, so an inspector sees the gap on every entry.
- **Measured from `recorded_at`:** the reversal window, idempotency and event emission.

---

## 12. API (Next.js route handlers)

### 12.1 Conventions

- **JSON** in camelCase.
- **Errors** follow §5. `details` never echoes input values.
- **Route order in every handler:**
  1. the self-check gate (§2.5);
  2. the session guard (§3.4; including the device lock, §3.6);
  3. the permission (§4);
  4. premises membership, where the route takes a premises (MR-19);
  5. the work.
- **Every route method is listed in the route table** (`lib/auth/routes.ts`) with its permission, or as public, or as self-only. The route-gate test drives every one (06b DX-77). A route missing from the table fails CI.
- **Lists** use `?limit` (default 50, max 200) and `?cursor` (an opaque keyset), and return `{ items, nextCursor }`.
- **Out-of-scope ids,** in the path or the body, return **404 `<ENTITY>_NOT_FOUND`**, byte-identical to an id that never existed. Under RLS the row simply is not visible, so this falls out naturally. A filter on a foreign id (e.g. `?patientId=` of another tenant) returns an empty list, exactly as for a random id.
- **Unknown body keys** → 422. **No schema accepts `orgId`.**

### 12.2 Idempotency

- **Required:** an `Idempotency-Key` header (8–128 characters, `[A-Za-z0-9_-]`) on every POST/PUT/PATCH. Missing → 400 `IDEMPOTENCY_KEY_REQUIRED`.
- **Exempt:**
  - `/api/auth/*` and `/api/account/*`, which have their own replay rules: a sign-in or a PIN is never replayed;
  - the read-only POSTs `dispenses/preview` and `imports/{id}/validate`.
- **Scope:** (`org_id`, key). `request_sha256` is the hash of method + path + canonical body. For a multipart upload, the body is the file's SHA-256 plus the form fields.
- **Mechanism:** the key row is inserted **first, inside the business transaction.** Postgres makes a concurrent insert of the same key wait on the uncommitted unique entry.
  - If the first request commits, the second **replays**: the original status, the resource re-read from the DB, and the header `Idempotent-Replayed: true`. No new rows are written.
  - If the first rolls back (any 4xx/5xx), its key disappears with it, so a retry runs normally. Only successes are remembered.
- **Misuse:** the same key with a different body → 422 `IDEMPOTENCY_KEY_REUSED`.
- **Defence in depth:** the natural-key UNIQUE (L-9) and the `stock_reversals` UNIQUE (L-10) prevent double posting even if this layer has a bug.

### 12.3 Endpoints (Phase 1)

**Sign-in and session** (`A`)

| # | Method and path | Access | Notes |
|---|---|---|---|
| A-01 | `GET /api/auth/context` | public | The sign-in context: the organisation (from the device cookie, the `pharm_org` cookie or `?org=<slug>`), its display name, and whether this browser is a trusted device (and its premises). Returns no ids. Unknown slug → 404 `ORG_NOT_FOUND`. |
| A-02 | `POST /api/auth/sign-in` | public | `{login, password}` |
| A-03 | `POST /api/auth/otp/start` | public | `{phone}` → 202 `{challengeId, channel}` for every well-formed number |
| A-04 | `POST /api/auth/otp/verify` | public | `{challengeId, code}` → session |
| A-05 | `POST /api/auth/otp/{challengeId}/sms` | public | the SMS fallback, from 30 s after start (409 `TOO_EARLY` before) |
| A-06 | `POST /api/auth/sign-out` | self | ends this session; on a trusted device the person leaves the lock screen |
| A-07 | `GET /api/auth/me` | self | name, role, effective permissions, memberships, device and its premises, lock deadline |
| A-08 | `POST /api/auth/activity` | self | the real-input ping (§3.6) |
| A-09 | `POST /api/auth/lock` | self, trusted device | "Switch person": locks now |
| A-10 | `GET /api/auth/device/people` | the trusted-device cookie | the lock screen: names and roles of the people with an open session on this device |
| A-11 | `POST /api/auth/device/switch` | the trusted-device cookie | `{sessionId, pin}` (the switch PIN) |
| A-12 | `POST /api/auth/reauth` | self | `{pin, purpose, entityId}` (the signing PIN or the password) → a single-use grant |
| A-13 | `PUT /api/account/password` | self | `{current, next}` |
| A-14 | `PUT /api/account/switch-pin` | self | `{pin}`; 422 `PIN_SAME_AS_OTHER`, `PIN_FORMAT` |
| A-15 | `PUT /api/account/signing-pin` | self | `{pin, password}` or `{pin, otpChallengeId, code}`; 422 `PIN_SAME_AS_OTHER` |
| A-16 | `POST /api/account/sessions/revoke` | self | ends all my sessions |

**Administration** (`M`)

| # | Method and path | Permission | Notes |
|---|---|---|---|
| M-01 | `GET` / `PUT /api/org/settings` (`If-Match`) | `org.settings` (+ grant for PUT) | lock minutes, day reset, untrusted idle |
| M-02 | `GET /api/premises` | any member | the caller's premises (owner: all) |
| M-03 | `POST /api/premises` | `org.settings` + grant | name, address, state code, GSTIN |
| M-04 | `PATCH /api/premises/{id}` | `org.settings` + grant | |
| M-05 | `GET` / `POST /api/staff` | `staff.manage` (+ grant for POST) | create returns a one-time password **once** |
| M-06 | `GET` / `PATCH /api/staff/{id}` | `staff.manage` (+ grant for PATCH) | name, role, memberships, prescriber link, phone, active. A role change revokes the person's sessions. |
| M-07 | `POST /api/staff/{id}/reset` | `staff.manage` + grant | a new one-time password; clears both PINs; revokes all the person's sessions |
| M-08 | `POST /api/staff/{id}/sessions/revoke` | `staff.manage` | |
| M-09 | `GET` / `POST /api/roles`; `PATCH /api/roles/{key}` | `roles.manage` (+ grant for writes) | custom roles and grant overrides; audited in the same transaction |
| M-10 | `GET` / `POST /api/devices` | `devices.manage` (+ grant `devices.register` for POST) | POST trusts **this** browser |
| M-11 | `POST /api/devices/{id}/revoke` | `devices.manage` | |
| M-12 | `GET /api/audit?from=&to=&action=&staffId=` | `audit.view` | |

**People and prescriptions** (`P`)

| # | Method and path | Permission | Notes |
|---|---|---|---|
| P-01 | `GET /api/patients?q=&phone=` | `patients.view` | |
| P-02 | `POST /api/patients` | `patients.edit` | warning `POSSIBLE_DUPLICATE` |
| P-03 | `GET` / `PATCH /api/patients/{id}` | `patients.view` / `patients.edit` | archive via `{archived: true}`; a merged patient returns `mergedInto` |
| P-04 | `GET` / `POST /api/prescribers` | any member / `prescribers.manage` | |
| P-05 | `GET` / `PATCH /api/prescribers/{id}` | any member / `prescribers.manage` | |
| P-06 | `GET /api/prescriptions?patientId=&premisesId=&status=` | `rx.view` | |
| P-07 | `POST /api/prescriptions` | `rx.enter` | header + optional lines |
| P-08 | `GET /api/prescriptions/{id}` | `rx.view` | lines, image ids, verification, dispensed quantities per line |
| P-09 | `POST /api/prescriptions/{id}/lines` | `rx.enter` | |
| P-10 | `POST /api/prescriptions/{id}/images` (multipart) | `rx.enter` | 413 `FILE_TOO_LARGE`; 422 `UNSUPPORTED_FORMAT` |
| P-11 | `GET /api/prescriptions/{id}/images/{imageId}` | `rx.view` | the bytes, with `Cache-Control: no-store` |
| P-12 | `POST /api/prescriptions/{id}/verify` | `rx.verify` + grant `prescription.verify` | only the prescriber's own linked user |
| P-13 | `POST /api/prescriptions/{id}/void` | `rx.enter` | |
| P-14 | `GET` / `POST /api/procedure-types`; `PATCH …/{id}` | any member / `stock.settings` | |
| P-15 | `GET /api/patients/duplicates` | `patients.merge` | likely duplicate pairs (same phone + similar name) |
| P-16 | `POST /api/patients/merges` | `patients.merge` + grant `patients.merge` | `{survivorId, mergedId, reason}` |
| P-17 | `POST /api/patients/merges/{id}/undo` | `patients.merge` + grant `patients.merge` | |

**Stock** (`E`, base path `/api/dispensary`)

| # | Method and path | Permission | Notes |
|---|---|---|---|
| E-01 | `GET /dispensary/settings` | `stock.view` | 409 `DISPENSARY_NOT_CONFIGURED` |
| E-02 | `POST /dispensary/setup` | `stock.settings` | 409 `ALREADY_CONFIGURED` |
| E-03 | `PUT /dispensary/settings` (`If-Match`) | `stock.settings` | 412 |
| E-04 | `GET /dispensary/premises` | `stock.view` | the caller's premises with stock settings and locations |
| E-05 | `POST /dispensary/premises/{id}/setup` | `stock.settings` + grant `premises.legal_settings` | mode (no default), licences, register fields, prescription age; creates the default and quarantine locations |
| E-06 | `PUT /dispensary/premises/{id}/settings` (`If-Match`) | `stock.settings` + grant `premises.legal_settings` | 422 `MODE_NOT_AVAILABLE` |
| E-07 | `PATCH /dispensary/locations/{id}` | `stock.settings` | rename |
| E-08 | `GET /dispensary/master?q=&salt=` | any member | global |
| E-09 | `GET /dispensary/master/{id}` | any member | |
| E-10 | `POST /dispensary/master/{id}/corrections` | `stock.items` | |
| E-11 | `GET /dispensary/master-corrections` | `stock.items` | the organisation's own requests only |
| E-12 | `GET /dispensary/items?q=&category=&lowStock=&nearExpiry=&premisesId=` | `stock.view` | |
| E-13 | `POST /dispensary/items` | `stock.items` | |
| E-14 | `GET /dispensary/items/{id}` | `stock.view` | units, batches, balances per premises and location |
| E-15 | `PATCH /dispensary/items/{id}` | `stock.items` | 409 `ITEM_IDENTITY_LOCKED` |
| E-16 | `POST /dispensary/items/{id}/units` | `stock.items` | |
| E-17 | `PATCH /dispensary/items/{id}/units/{unitId}` | `stock.items` | flags only; the factor is immutable |
| E-18 | `GET /dispensary/items/{id}/movements` | `stock.view` | ledger history; **no patient fields** |
| E-19 | `GET` / `POST /dispensary/tax-rates` | `stock.view` / `stock.items` | 422 `TAX_RATE_OVERLAP` |
| E-20 | `GET` / `POST /dispensary/suppliers` | `stock.view` / `stock.items` | |
| E-21 | `GET` / `PATCH /dispensary/suppliers/{id}` | `stock.view` / `stock.items` | |
| E-22 | *(removed in Rev 3)* | — | prescribers are P-04/P-05 |
| E-23 | `GET` / `POST /dispensary/goods-receipts` | `stock.view` / `stock.receive` | create needs `premisesId`; optional `receivedAt` (+ `backdateReasonCode`) under the backdating tier |
| E-24 | `GET` / `PATCH /dispensary/goods-receipts/{id}` | `stock.view` / `stock.receive` | 409 `GRN_NOT_DRAFT` |
| E-25 | `POST /dispensary/goods-receipts/{id}/post` | `stock.receive` | |
| E-26 | `POST /dispensary/goods-receipts/{id}/discard` | `stock.receive` | |
| E-27 | `POST /dispensary/dispenses/preview` | `stock.dispense` | read-only |
| E-28 | `POST /dispensary/dispenses` | `stock.dispense` (+ `stock.backdate` / `stock.backdate_extended`) | optional `prescriptionId` + per-line `prescriptionLineId` |
| E-28a | `GET /dispensary/prescriptions/{id}/dispensable` | `stock.dispense` + `rx.view` | the prescription's lines beside the stock items staff may pick for each; for MR-18 lines, the remaining prescribed quantity. Pre-selected where the line has an `item_id`; never auto-dispensed. |
| E-29 | `GET /dispensary/dispenses?patientId=&premisesId=&prescriptionId=&from=&to=` | `dispense.view` | |
| E-30 | `GET /dispensary/dispenses/{id}` | `dispense.view` | |
| E-31 | `POST` / `GET /dispensary/procedure-uses`, `GET …/{id}` | `stock.dispense` / `stock.view` | the patient link appears only for callers with `dispense.view` |
| E-32 | `POST` / `GET /dispensary/patient-returns`, `GET …/{id}` | `stock.dispense` / `dispense.view` | |
| E-33 | `POST` / `GET /dispensary/supplier-returns`, `GET …/{id}` | `stock.writeoff` (+ grant) / `stock.view` | |
| E-34 | `POST` / `GET /dispensary/adjustments`, `GET …/{id}` | `stock.writeoff` (write-off kinds) or `stock.adjust` (+ grant) / `stock.view` | |
| E-35 | `POST` / `GET /dispensary/reversals` | `stock.adjust` + grant `stock.reverse` / `stock.view` | |
| E-36 | `GET /dispensary/containers?status=&premisesId=` (P1-C) | `stock.view` | remaining units, `discardAfter`, a lapsed flag |
| E-37 | `POST /dispensary/containers/{id}/discard` (P1-C) | `stock.dispense` | |
| E-38 | `GET /dispensary/alerts?premisesId=` | `stock.view` | recent events |
| E-39 | `GET /dispensary/reports/{stock-overview, expiry, low-stock, consumption, non-moving, valuation, entry-lag, lapsed-use}?premisesId=` | `stock.reports` | `premisesId` omitted = the whole organisation (entry-lag and lapsed-use: per premises) |
| E-40 | `GET /dispensary/registers/{h1, purchase}?premisesId=&from=&to=&format=` | `stock.registers` + grant `register.export` for `csv` and `print` | **`premisesId` required**; 422 `PERIOD_TOO_LONG` (> 366 days) |
| E-41 | `POST /dispensary/imports` (multipart, `locationId`) | `stock.import` | 413 `FILE_TOO_LARGE`; 422 `UNSUPPORTED_FORMAT` |
| E-42 | `GET /dispensary/imports/{id}`, `GET …/rows` | `stock.import` | the dry-run report |
| E-43 | `PATCH /dispensary/imports/{id}/rows/{rowId}` | `stock.import` | confirm, custom, skip, fix |
| E-44 | `POST /dispensary/imports/{id}/{validate, commit, abandon}` | `stock.import` (+ grant `stock.import_commit` for commit) | 409 `IMPORT_HAS_ERRORS`, `IMPORT_ALREADY_COMMITTED` |

`GET /api/health` is public and returns only `{ok, schemaVerified}`.

### 12.4 Key shapes

```jsonc
// POST /api/dispensary/dispenses          Idempotency-Key: 6f1c…
{
  "premisesId": "uuid", "locationId": null,                 // null → the premises' default location
  "patientId": "uuid", "prescriberId": "uuid",
  "prescriptionId": "uuid",                                  // an ACTIVE prescription record of this patient, or null
  "occurredAt": null,                                        // or "2026-10-06T12:30:00Z" when backdated
  "backdateReasonCode": null, "backdateNote": null,
  "lines": [{
    "itemId": "uuid", "unitId": "uuid", "quantity": "1.5",              // int or decimal string
    "prescriptionLineId": "uuid",                                        // required for MR-18 items
    "unitPricePaise": 4500, "discountPaise": 0,                          // optional (null = unpriced)
    "daysSupply": 10,                                                    // optional, staff-entered
    "substitution": {"forItemId": "uuid", "reason": "brand out of stock"},  // optional, all-or-none
    "allocations": [{"batchId": "uuid", "qtyBase": 15}]                  // optional manual pick
  }]
}
// 201
{ "id": "uuid", "status": "COMPLETED", "modeSnapshot": "RMP_OWN_PATIENTS",
  "premisesId": "uuid", "occurredAt": "2026-10-07T04:30:00Z", "recordedAt": "2026-10-07T04:30:00Z",
  "lines": [{ "lineNo": 1, "qtyBase": 15, "grossPaise": 6750, "netPaise": 6750,
              "allocations": [{ "batchId": "uuid", "batchNo": "PCM2312", "expiryDate": "2026-12-31",
                                "qtyBase": 15, "selection": "FEFO" }] }],
  "warnings": [{ "code": "NEAR_EXPIRY", "lineNo": 1 }] }
// 409
{ "error": "Not enough stock for line 1.", "code": "INSUFFICIENT_STOCK", "requestId": "…",
  "details": [{ "lineNo": 1, "itemId": "uuid", "requestedBase": 30,
                "availableBase": 18, "expiredOnHandBase": 15 }] }
```

```jsonc
// POST /api/prescriptions                  Idempotency-Key: …
{ "premisesId": "uuid", "patientId": "uuid", "prescriberId": "uuid",
  "source": "MANUAL", "prescribedOn": "2026-10-06", "serialText": "SE/1042",
  "lines": [{ "medicineText": "Isotretinoin 20 mg", "itemId": "uuid",
              "qtyText": "1 OD x 30 days", "qtyBasePrescribed": 30 }] }

// POST /api/auth/device/switch            (trusted-device cookie)
{ "sessionId": "uuid", "pin": "482915" }
// 200 → new pharm_session cookie; 401 { "error": "Wrong PIN.", "code": "wrong_secret", "details": { "remaining": 3 } }

// POST /api/dispensary/reversals           Idempotency-Key: …
{ "documentType": "DISPENSE", "documentId": "uuid", "reasonCode": "WRONG_PATIENT",
  "note": null, "reauthGrant": "uuid" }
```

---

## 13. Events and scheduled jobs

| Event | Emitted | Dedupe key | Payload (ids and integers only) |
|---|---|---|---|
| `stock.low` | in the transaction (a movement-driven crossing); by the daily job (an expiry-driven crossing) | `stock.low:{itemId}:{premisesId}:{movementId}` or `…:expiry:{istDate}` | `itemId, premisesId, onHandAfter, reorderLevel` |
| `batch.near_expiry` | daily job | `batch.near_expiry:{batchId}:{windowDays}` | `batchId, itemId, expiryDate, windowDays, onHand` |
| `batch.expired` | daily job | `batch.expired:{batchId}` | `batchId, itemId, expiryDate, onHand` |
| `dispense.completed` | in the transaction | `dispense.completed:{dispenseId}` | `dispenseId, lineCount`. **No patient id alongside item ids;** a consumer re-reads through the API. |
| `ledger.drift_detected` | reconciliation | `ledger.drift:{runId}` | `runId, driftCount` |
| `container.lapsed` (P1-C) | daily job (still `OPEN` past `discard_after`) | `container.lapsed:{containerId}` | `containerId, itemId, batchId, remainingUnits` |

- **The Phase 1 consumer is the dashboard only.** Badges are computed live from balances and containers, not from events, so they never go stale. **Stock code never calls Meta or any other external service** (06b DJ-09).
- **Job runner:** `scripts/daily.ts`, run with `tsx` by a **Railway cron service** (06 OQ-17). No job framework.
  - It connects as `pharmacy_jobs`: not a superuser, no `BYPASSRLS`. It reads the organisation list through the `org_directory` policy, then processes each organisation inside `withTenant`.
  - **00:10 IST:** near-expiry and expired events; expiry-driven `stock.low`; `container.lapsed`.
  - **02:30 IST:** reconciliation.
  - **Purges:** idempotency keys older than 7 days; OTP challenges older than 1 day; sessions that ended more than 90 days ago.
  - **Daily:** raise `items.requires_prescription` where a linked master's flag was raised (D-32).
  - **Weekly:** the total size of `prescription_images` (all organisations) and the count of PIN hashes per pepper version; an alert at **8 GB** of images (D-35) and while an old pepper version still has hashes (§3.12). Counts and sizes only.
  - Every step is idempotent per IST date and based on state, so a missed day catches up.
- **Lapsed-container prompts are live.** The stock overview and procedure screens compute "discard pending" from `discard_after < now()` on every load. The hard block (MR-17) is evaluated at use time.

---

## 14. Registers and reports (always derived from the ledger and documents)

| Report | Scope | Source | Columns / definition |
|---|---|---|---|
| **Schedule H1 register** | **per premises** (required) | `dispense_lines` with `'H1' = ANY(schedule_flags_snapshot)`, joined to `dispenses` (snapshots) and allocations → `batches` | • Date **and time** of supply (IST, from `occurred_at`) **and** date and time recorded (`recorded_at`), **on every row** (D-10).<br>• The prescriber's name, registration number and council, and address.<br>• The patient's name.<br>• The medicine (name + strength snapshot).<br>• Quantity (base units and as entered).<br>• Batch number and expiry.<br>• The prescription's serial (or its short id) when linked.<br>• The configured extras.<br>**Reversed dispenses stay**, marked "Reversed on … (reason)". |
| **Purchase register** (Schedule K record) | **per premises** (required) | `goods_receipt_lines` of `POSTED`/`REVERSED` GRNs at that premises, with the supplier snapshot | invoice number and date; **received at** and **recorded at**; the supplier's name, address, GSTIN, licence numbers and validity; item; the manufacturer's name **and address**; batch; expiry; qty; free qty; rate; MRP. Reversed GRNs are marked, never removed. |
| **Entry-lag report** (D-12) | per premises | every backdatable header | The distribution of `recorded_at − occurred_at` by role and document type, and the share needing a reason. This is the pilot data used to tune `backdate_reason_after_minutes`. It is not a register and holds no patient fields. |
| **Lapsed-container use** (P1-C, D-16) | per premises | `procedure_use_allocations` with `lapse_override_reason` | date, prescriber, item, batch, container, units, minutes past `discard_after`, reason. Empty under `BLOCK`. No patient name: the procedure-use id is a link for `dispense.view` holders. |
| Expiry | the organisation, or `premisesId` | balances (`on_hand > 0`) × `batches` | Expired, quarantined, and within each configured window. Grouped by supplier (from receipt lines: a batch bought from two suppliers appears under each, with the qty received) and by manufacturer. |
| Low stock and reorder suggestion | per premises | balances × `batches` × `items` | dispensable on-hand `< reorder_level`; suggestion = `max(reorder_qty, reorder_level − dispensable_on_hand)` (deterministic; consumption-based suggestions are Phase 2) |
| Consumption | the organisation, or `premisesId` | `DISPENSE` + `PROCEDURE_USE` movements, net of their reversals and returns | by item, by prescriber, by procedure type or performing prescriber, by IST day/week/month |
| Non-moving | the organisation, or `premisesId` | balances × movements | `on_hand > 0` and no use in the last N days (default 90) |
| Valuation | the organisation, or `premisesId`; `as_of` | Σ movements with `occurred_at ≤` the end of the `as_of` IST day | • **At cost:** on-hand × the batch's cost per base unit, where cost = Σ(qty × rate − discount) / Σ((qty + free) × factor) over that batch's receipt lines, rounded half-up once per batch total. Opening balances without cost show "cost unknown".<br>• **At MRP:** on-hand × `M/n`, floored once per batch total. |

- **Stock overview** shows units held in lapsed containers as "discard pending" (P1-C).
- **Exports:** CSV in UTF-8 with a BOM, `DD-MM-YYYY HH:mm` IST, and rupees with 2 decimals, formatted from paise by integer formatting.
  - Every register export needs a signing-PIN grant (`register.export`).
  - Every export writes an `audit_log` row, `register.exported`, in the same transaction.
- **Printable registers are an HTML print view** (§1.2). The browser shapes Gujarati and Devanagari names correctly. Print CSS repeats a header block on every page with:
  - the premises' name, address, state and licence numbers;
  - the period;
  - page numbers;
  - "generated at (IST)".

  A server-side PDF is Phase 2, if an inspector wants files.
- **Retention:** register sources are never deleted (L-15). A DPDP erasure request must not delete or anonymise register snapshots within the legal retention period (06 OQ-11).

---

## 15. Onboarding import

**Flow:** upload → parse (adapter) → dry-run report → human confirmations → validate → commit (one transaction) or abandon.
- Nothing touches the ledger before commit.
- An import targets **one location**, and so one premises.

- **Formats:** CSV and XLSX, ≤ 5 MB and ≤ 5,000 rows. XLSX is read with `exceljs`, a library rather than a framework (06 OQ-19).
- **Adapter interface:**
  ```ts
  interface StockImportAdapter {
    name: string;
    detect(headerRow: string[]): boolean;
    rows(file: Buffer): Iterable<RawRow>;   // canonical keys only; unknown columns dropped
  }
  ```
  Phase 1 ships `generic_csv` and `generic_xlsx` against Engageo's published template. Adapters for exports from common Indian pharmacy software are Phase 2 (which ones: 06 OQ-19).
- **Parsing:** money and quantities are parsed from strings to integers, with no float at any step.
  - Strip `₹`, `,` and spaces. Money with more than 2 decimals is a row error.
  - XLSX numeric cells: `String(cell)` → integer parse.
- **Matching to `medicine_master`:**
  - Deterministic: normalised brand name, `pg_trgm` similarity, and a manufacturer and strength token bonus. Up to 5 candidates, with scores.
  - **A human confirms every match.** "Confirm all exact matches" is one explicit bulk action by a named user, recorded in `confirmed_by`.
  - An unmatched row becomes a custom item only when the human chooses `CUSTOM`.
  - No LLM. No consumer pharmacy website is ever scraped.
- **Row issues:**
  - `MISSING_EXPIRY`: an error, for tracked items.
  - `EXPIRED_BATCH`: a warning. The row is committed as an opening balance **into the premises' `QUARANTINE` location** (D-14) and shown in the expiry report.
  - `QTY_NOT_WHOLE_BASE_UNITS`, `BAD_MONEY`, `DUPLICATE_ROW`, `BATCH_MRP_MISMATCH`.
  - `UNMATCHED`: blocks commit until decided.
  - `BALANCE_KEY_HAS_MOVEMENTS`: use an adjustment instead.
  - `LICENCE_REQUIRED_NDPS` / `_SCHEDULE_X`: for the target premises.
- **Commit:**
  - locks the import row;
  - requires `VALIDATED` and zero errors, plus a signing-PIN grant;
  - creates items, units, batches and `OPENING_BALANCE` movements (`reference_type = STOCK_IMPORT_ROW`) in canonical order;
  - sets status `COMMITTED`.

  It is idempotent through the key, the status transition and the `file_sha256` UNIQUE.
- **Reversal:** `reverse_document(STOCK_IMPORT)` is allowed while none of its keys has a later movement, so a wrong first import can be undone during onboarding.

---

## 16. UI (Phase 1)

**Kit:** a copy of Ritu Desk's component kit (§1.2):
- `DataList`, `Sheet`, `Dialog`, `Combobox`, `Field`, `Badge`, `StatusPill`, `KpiCard`, `EmptyState`;
- the custom Tailwind palette, enforced by a class lint;
- SWR polling;
- en/hi/gu dictionary entries for every string, with Latin digits;
- `fmtPaise` for money.

| Screen | Behaviour |
|---|---|
| **Sign-in** | Reached from the organisation's link or on a trusted device. Phone (OTP over WhatsApp, "send by SMS instead" after 30 s), or login + password. After a first sign-in on a trusted device: "set your switch PIN". |
| **Who's working?** (trusted device) | Large name tiles for the people signed in today; tap → 6-digit switch PIN → in. "Someone else" → full sign-in. Shown after `device_lock_minutes` without input, on "Switch person", and on any 401 `device_locked`. Clears the page's data from memory when it appears. |
| **Signing PIN dialog** | Appears only for the §3.7 purposes. Says what is being signed ("Reverse dispense #…"). Never accepts the switch PIN. |
| **Patients** | Search by name or phone. Create with name and phone, plus address/DOB only when a premises' register needs them. A duplicate warning (name + phone) shows candidates. **Merge tool** (owner): likely duplicates side by side with their document counts → choose the survivor → reason → signing PIN; merges can be undone. No clinical fields. |
| **Prescriptions** | **Record from a photo:** camera or upload, with the downsize done in the browser; then type the lines (medicine as written, optional item match, quantity as written and, for MR-18 items, the total in base units). **Manual entry:** the same form without a photo. **Verify** (the prescriber only): photo and lines side by side, then the signing PIN. Void, with a reason. |
| Premises picker | In the header. Defaults to the trusted device's premises. Sets the default premises for every action. Registers are always per premises; reports default to the whole organisation. |
| Stock overview | Search by name or salt. On-hand per premises (base units + packs). Badges `LOW`, `NEAR EXPIRY (≤ N d)`, `EXPIRED STOCK`, `DISCARD PENDING` (P1-C). |
| Item detail | Units; batches (expiry, on-hand per location, MRP); the full ledger history (type, qty, batch, actor, time in IST, document link). Read-only: no edit affordance exists. **No patient names.** |
| Receive stock (GRN) | A supplier picker with a licence-status chip; line entry with expiry as `MM/YYYY`; save a draft; post after reviewing the warnings. |
| Dispense | **Opened only from a patient or a prescription record**, never free-floating at an RMP premises.<br>• **From a prescription:** each transcribed line (medicine as written, quantity as written, remaining prescribed quantity for MR-18 items) sits beside a stock-item picker and the photo. A line's matched item is pre-selected; nothing is auto-dispensed, and lines not dispensed stay visibly undispensed.<br>• **On every line:** the dispensable on-hand at this premises; the FEFO suggestion with an optional batch override; an MRP ceiling hint; salt-based alternatives as information only (choosing one needs a substitution reason).<br>• **Backdating:** a "handed over earlier" toggle reveals `occurredAt`. A reason is asked only beyond the organisation's reason-free lag, and the toggle is absent for H1/X/NDPS lines.<br>• **Preview, then confirm.** The client generates the idempotency key once per confirm dialog, so a double click reuses it. |
| Procedure use | From a patient, with an optional procedure type. For a multi-dose item (P1-C), shows the open container's remaining units and a countdown to `discardAfter`. A lapsed container blocks use and offers one-click "Discard remaining N units". Under the `DOCTOR_OVERRIDE` policy, a prescriber-linked user sees "Use anyway", which needs a reason and the signing PIN. |
| Returns & write-offs | A patient return starts from a dispense (allocations, returnable qty, disposition). Supplier return. Write-off with a mandatory reason. Reversal with a mandatory reason, showing what will be undone. Each of the last three asks for the signing PIN. |
| Registers & reports | Premises (required for registers), IST date range, preview, CSV, print view |
| Settings | **Organisation:** lock minutes, day reset, untrusted idle. **Premises:** address, state, GSTIN, mode (with an explanation of each), licences, register fields, prescription age. **Staff, roles, devices** (with "Trust this PC"), **audit log**, **suppliers**, **prescribers**, **procedure types**, location names. |

**Dashboard:** low stock, near expiry and discard pending appear as count chips linking to the stock overview. There is no other notification mechanism in v1.

---

## 17. Boundaries

- **WhatsApp.**
  - **Staff OTP** (§3.9) is the only WhatsApp traffic in v1: an authentication template from an Engageo-owned number. It never carries patient or medicine data.
  - **Patient messages are out of v1.** If refill reminders come in Phase 2, the boundary is fixed now:
    - allowed: a prompt to book a follow-up or call the clinic, timed from `days_supply`;
    - never: ordering flows, carts, payment links, bills or receipts for medicines;
    - the template does not name the medicine;
    - **hard prerequisite:** recorded opt-in and immediate opt-out, which do not exist yet.
- **Ritu Desk.** No integration in v1 (D-28). Whether an organisation using both should share one login and sync patients through an API later is 06 OQ-30. Nothing in v1 blocks either: ids are UUIDs, and a link table can be added later without changing existing tables.
- **Ritu voice.** No connection. No voice tool reads or changes this app's data.
- **Ritu Desk Spec 07.** This spec does not depend on it (D-29). Spec 07 stays Ritu Desk work on its own track.
- **Prescribing.** This app records prescriptions; it never writes one, suggests a drug, or computes a dose or quantity.
- **Billing.** Phase 1 stores price snapshots only. GST invoices are designed once 06 OQ-3 is answered.
- **AI.** None anywhere in the app (§0.7).

---

## 18. Migration plan

**Tool:** the app's own runner, `scripts/migrate.cjs`, applying `migrations/NNN_name.sql` in order:
- it runs as `pharmacy_migrator` through `MIGRATION_DATABASE_URL`, as the deploy's pre-start step;
- one transaction per file;
- a SHA-256 per applied file is recorded in `schema_migrations`;
- **an edited applied file, or any failure, exits non-zero, and the deploy fails.**

**Forward-only (D-21). No down migrations.**
- On an append-only ledger, a down migration is a data-deletion script.
- From the first release onward, every migration keeps the **previous app version working against the new schema:** additive first, contract only once the code that needs the old shape is gone.
- **The rollback is a backup restore.** One restore drill is done before the first organisation's real data goes in (06b DMG-10):
  1. restore the latest production backup into a scratch Railway Postgres;
  2. run the self-check and the reconciliation job against it;
  3. record the time it took.

**Before migration 001,** `ops/bootstrap-roles.sql` is run once by the platform superuser. It creates the §2.2 roles and grants `pharmacy_resolver` to the migrator, so the migrator can hand over ownership of the resolver function.

**Extensions:** `pg_trgm` and `btree_gist` are trusted extensions (PG 13+), so the database owner can install them without superuser.

**Every migration:**
- enables and forces RLS on its tables;
- creates the tenant policy;
- grants the app role exactly what it needs:
  - SELECT/INSERT on ledger, history, audit and document tables;
  - UPDATE only on mutable tables (settings, items, suppliers, drafts, sessions, devices, staff, patients, prescription headers' verify/void columns);
  - DELETE only on `idempotency_keys`, `otp_challenges` and draft lines;
  - never TRUNCATE.

**The jobs role** gets SELECT across the stock tables, INSERT on `outbox_events` and `ledger_reconciliation_runs`, and the purge DELETEs.

**Milestone 1, in build order** (PR numbers are Milestone 1's, §19):

| # | Change (one logical change each) | PR |
|---|---|---|
| 001 | **Tenancy foundation** (R6-7): `pg_trgm`, `btree_gist`; `forbid_mutation()`, `ist_date()`; `organisations` (+ RLS on `id`, the `org_directory` policy, `auth_resolve_org()` owned by `pharmacy_resolver`); `premises`; grants | 1 |
| 002 | `org_settings` + history | 2 |
| 003 | `org_roles`, `role_grants` (the grants model) | 2 |
| 004 | `prescribers` (before `staff_users`, which links to them) | 2 |
| 005 | `staff_users` | 2 |
| 006 | `staff_premises` | 2 |
| 007 | `devices` | 2 |
| 008 | `sessions` | 2 |
| 009 | `device_state` | 2 |
| 010 | `audit_log` (+ append-only trigger) | 2 |
| 011 | `reauth_grants` | 3 |
| 012 | `medicine_master`; `GRANT SELECT` to the app role (the seed is data, loaded by `pharmacy_curator`, R6-5) | 5 |
| 013 | `stock_settings` + history | 5 |
| 014 | `premises_settings` + history | 5 |
| 015 | `stock_locations` | 5 |
| 016 | `items`, `item_units` (+ freeze and immutability triggers); includes the nullable multi-dose columns | 5 |
| 017 | `suppliers` | 5 |
| 018 | `patients` | 6 |
| 019 | `prescriptions`, `prescription_lines` (+ immutability triggers) | 6 |
| 020 | `prescription_images` | 6 |
| 021 | `batches` (per premises) | 7 |
| 022 | `stock_movements` + `stock_balances` + the validate / apply / as-of / append-only triggers. The ledger and its cache are one logical change: the cache is defined by the trigger. | 7 |
| 023 | `idempotency_keys` | 7 |
| 024 | `goods_receipts` (+ lines; posted-immutability trigger) | 8 |
| 025 | `dispenses` (+ lines, allocations, the L-25 trigger); includes the nullable `LICENSED_PHARMACY` and backdate columns (R6-9) | 9 |
| 026 | `patient_returns` (+ lines) | 9 |
| 027 | `stock_adjustments` (+ lines; `opened_container_id` nullable, its FK added in Milestone 2) | 9 |
| 028 | `stock_reversals` | 9 |
| 029 | `stock_imports`, `stock_import_rows` | 11 |

**Milestone 2, numbered when built:** `otp_challenges`, `item_tax_rates`, `procedure_types`, `patient_merges` (+ the `patient_canonical` view), `opened_containers` (+ the FK on `stock_adjustment_lines`), `procedure_uses`, `supplier_returns`, `outbox_events`, `ledger_reconciliation_runs`, `master_correction_requests` (+ the `curation_*` policies).

- **Every table is created with the §2.6 keys from the start:** `PRIMARY KEY (org_id, id)`, composite FKs (with `premises_id` where stock is named), and `org_id` in every unique constraint.
- **Adding to an earlier table** (R6-8): a later migration may add a nullable column, an index, a constraint (`NOT VALID`, then validated) or an FK. It never drops, renames or retypes anything, and the previous app version keeps working (06b DMG-08, DMG-11).
- **The `devices` ↔ `sessions` cycle** is broken by `device_state`.

---

## 19. Milestone 1 PR plan (never stacked on red tests)

**Rules for every PR (D-40):**
- written against this spec and a freshly fetched commit, recorded in the PR description;
- tests for every rule it touches;
- the full suite green before the next PR starts;
- no hosting: everything runs locally.

**Branches:** each PR is a branch based on the previous one (`m1/pr-01-foundation`, `m1/pr-02-…`). The spec branch is its base.

| PR | Contents | Migrations | Gate (06b) |
|---|---|---|---|
| **1** | **Foundation:**<br>• the Next.js 14 scaffold;<br>• `lib/db` (pool, `withTenant`, the int8 parser);<br>• the migration runner, which fails the deploy on any error and checks checksums;<br>• `ops/bootstrap-roles.sql`;<br>• the self-check and the 503 gate; `GET /api/health`;<br>• the real-Postgres harness;<br>• the catalog, isolation and route-inventory checks. | 001 | DS-01 … 10, 13 … 15, 17 … 21; DMG-01 … 05, 07 … 09, 12 … 14; DH-05, 07, 12; DX-76 |
| **2** | **Staff identity:** org settings, roles and grants, prescribers (table), staff and memberships, devices and sessions (tables), password sign-in (A-01 … A-02, A-06, A-07, A-13, A-16), the guard, the founder CLI, the audit log; the sign-in screen | 002–010 | DN (password rows), DAU, DS/DMG for the new tables, DX-01 … 04 |
| **3** | **The shared PC:** trusted devices, "Who's working?", the idle lock, the switch PIN, the signing PIN with the pepper, re-auth grants (A-08 … A-12, A-14, A-15) | 011 | DW, DPN-01 … 11, 13 … 17, DX-05 … 08 |
| **4** | **Administration:** premises, staff, roles, devices, the audit view (M-01 … M-12) and their screens; the UI kit copied in | — | DI (administration rows), DX-09 … 19 |
| **5** | **Catalogue and settings:** the minimal master, stock and premises settings, locations, items and units, suppliers (E-01 … E-09, E-12 … E-18, E-20, E-21) | 012–017 | DG-01 … 03, 05 … 11; DX-33 … 37, 39 … 43, 45 |
| **6** | **People:** patients, prescribers, prescriptions (manual and photo) (P-01 … P-13) | 018–020 | DRX-01 … 16; DX-20 … 31 |
| **7** | **Ledger:** batches, movements, balances, triggers, idempotency | 021–023 | DL (M1 rows), DP-01 … 08, 10, 12; DA; DK-01 … 03 |
| **8** | **Receiving stock** (E-23 … E-26) | 024 | DO-01 … 04; DM-04 … 06; DX-46 … 49 |
| **9** | **Dispensing:** FEFO, the M1 mode rules, `requires_prescription`, patient returns, write-offs, reversals (E-27 … E-30, E-32, E-34, E-35) | 025–028 | DE, DU (except DU-17), DK, DM (M1 rules), DO (M1 rows), DC (M1 rows); DX-50 … 58, 60, 62, 63 |
| **10** | **Views and registers:** stock overview, low stock, near expiry; the H1 and purchase registers, print and CSV (E-38 … E-40) | — | DR (M1 rows); DX-65 … 68 |
| **11** | **CSV import of opening stock** (E-41 … E-44) | 029 | DIM (CSV rows); DX-69 … 72 |
| **12** | **Pilot readiness:** the stock screens finished; an end-to-end "day at one premises" test; a demo seed script | — | the Milestone 1 gate (06b §30) |

Each PR follows the same order: migrations → queries/service → tests → routes → UI.

---

## 20. Out of scope

- **Integrations:**
  - **Ritu Desk integration** in v1: shared login, patient sync (06 OQ-30);
  - any link to the Ritu voice server.
- **Prescribing:**
  - writing or e-signing prescriptions;
  - OCR or any automatic reading of prescription photos.
- **Patients:**
  - automatic merging (merges are always a person's decision, D-36);
  - patient messaging of any kind in v1.
- **Selling and money:**
  - online ordering or delivery;
  - any WhatsApp flow that sells, orders or takes payment for medicines;
  - distributor scheme accounting, GSTR filing, e-way bills, e-invoicing, Tally sync;
  - loyalty programmes, MR commission, insurance.
- **Clinical decision support:** no dose calculation, no interaction checking, no automatic substitution. `in_use_hours` is copied from the label, never computed.
- **Stock, later phases:**
  - temperature logging (Phase 3);
  - partitioning;
  - inter-state stock transfers (blocked until a GST stock-transfer spec exists);
  - per-premises reorder levels and rack locations (Phase 2);
  - a server-side PDF for registers (Phase 2);
  - object storage for prescription photos, until the 10 GB threshold (D-35).
- **Platform:**
  - down migrations (D-21);
  - single sign-on with any other app.
