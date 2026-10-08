# Spec 06b — Clinic Pharmacy Tool: Acceptance Gate

**Status:** **Rev 6.1 (standalone)**, 2026-10-08. Self-contained. Revisions 4–6 were squashed when the history was cleaned (2026-10-08). §30 lists which rows gate Milestone 1.
**Written against:** clinic-pharmacy-tool `origin/main` @ `6f5ffb2` (fetched 2026-10-08; README only). Stack conventions from Ritu Desk `origin/main` @ `8bee594` (fetched 2026-10-08).
**Type:** acceptance spec (a test set, not a behaviour doc), in the style of Spec 01.
**Defines "done" for:** [06a](06a-dispensary-ledger.design.md) Phase 1 · **Index and decisions:** [06](06-dispensary-ledger.md)

The workflow is strict TDD, as Spec 01 prescribes:
1. write each PR's rows against the target API;
2. watch them fail;
3. implement.

**A row that was never red proves nothing.**

**Test IDs.** Rows kept from Rev 3 keep their IDs. Rows that no longer apply are marked *withdrawn*, never renumbered. New families:

| Prefix | Covers |
|---|---|
| DN | sign-in and sessions |
| DW | trusted devices, switching and the idle lock |
| DPN | PINs and re-auth |
| DQ | phone OTP |
| DRX | patients, prescribers and prescriptions |
| DAU | the audit log |

---

## 1. Prerequisites

- **No external prerequisite.** Nothing depends on Ritu Desk or its Spec 07.
- **Harness (`npm test`):**
  1. starts a throwaway Postgres ≥ 15 cluster from the local binaries (`initdb`/`pg_ctl`, TCP on 127.0.0.1), or uses `TEST_PG_SUPERUSER_URL` when one is given (06a §1.2, R6-6);
  2. runs `ops/bootstrap-roles.sql` as that server's superuser;
  3. applies the real `migrations/` with the real runner as `pharmacy_migrator`;
  4. connects the app as `pharmacy_app`.

  Never a hand-written DDL dump.
- **Tools:**
  - test runner: `node:test` + `node:assert`;
  - property tests: `fast-check`;
  - an injectable clock (`lib/clock.ts`).
- **OTP providers sit behind an interface.** Tests use a recording fake (`fakeOtpChannel`), so there are no network calls (DH-14).
- **Real identity in every route row.** A row signs in through the real endpoints (A-02, A-11). There is **no test-only identity seam** in production code (DH-15).

---

## 2. Actors and seeded fixtures (`seedWorld`)

- **Clock.** The default is pinned at **2026-10-07 10:00:00 IST** (`2026-10-07T04:30:00Z`).
- **Fresh world.** Each row starts from a fresh `seedWorld` unless it says otherwise.
- **Synthetic data.** All data is synthetic. Schedule flags in fixtures are **test data, not regulatory truth**. Phone numbers have the form `+91 98000 000xx`.

### Organisations, premises and devices

| Org (slug) | Premises | State | GSTIN | Mode | Licences | H1 extras | Locations | Trusted devices |
|---|---|---|---|---|---|---|---|---|
| **A** (`org-a`) | **A_GJ** | 24 (Gujarat) | `24AAAAA0000A1Z5` | `RMP_OWN_PATIENTS` | none | `{PATIENT_ADDRESS}` | LOC_A_GJ (STORE, default), LOC_A_GJ_Q (QUARANTINE) | DEV_A_GJ (front desk), DEV_A_GJ2 |
| **A** | **A_MH** | 27 (Maharashtra) | `27AAAAA0000A1Z9` | `CONSUMABLES_ONLY` | none | `{}` | LOC_A_MH, LOC_A_MH_Q | DEV_A_MH |
| **B** (`org-b`) | **B_GJ** | 24 | — | `RMP_OWN_PATIENTS` | none | `{}` | LOC_B_GJ, LOC_B_GJ_Q | DEV_B_GJ |

UNTRUSTED is a browser with no device cookie.

**Org A settings:**
- **security:** `device_lock_minutes` 3; `day_reset_time_ist` 04:00; `untrusted_idle_minutes` NULL;
- **stock:**
  - near-expiry windows {30, 60, 90}; reversal window 24 h;
  - backdating: **reason-free lag 120 min**, **standard window 48 h**, **extended window 168 h**;
  - **scheduled-drug entry lag 30 min** (D-22);
  - `procedure_use_patient_link = REQUIRED_FOR_INJECTABLES`;
  - `opened_container_lapse_policy = BLOCK`;
  - `intra_state_transfers_enabled = false`;
- **premises:** `prescription_max_age_days` NULL.

### Staff (grants are the 06a §4.2 defaults unless stated)

| Handle | Org | Role | Premises | Prescriber link | Login · phone |
|---|---|---|---|---|---|
| AA | A | `owner` | all | — | `aa` · +91 98000 00010 |
| A1 | A | `doctor` | A_GJ | DOC_A1 | `a1` · +91 98000 00011 |
| A2 | A | `doctor` | A_MH | DOC_A2 | `a2` · +91 98000 00012 |
| AF | A | `reception` | **A_GJ only** | — | `af` · +91 98000 00013 |
| AM | A | `reception` | **A_MH only** | — | `am` |
| AS | A | **`store`**, a custom role with rows {`stock.view`, `stock.receive`, `stock.reports`} | A_GJ | — | `as` |
| AX | A | `reception` | A_GJ | — | `ax`, **deactivated** |
| AN | A | `reception` | **none** | — | `an` |
| BA | B | `owner` | all | — | `ba` · +91 98000 00020 |

Every person has a password, a **switch PIN** and a **different signing PIN**, from a fixture table. No PIN is a run or a repeat.

### Patients, prescribers, procedure types, suppliers

| Handle | Org | Data |
|---|---|---|
| P_SUNITA | A | Sunita Patil, +91 98000 00001, "12 Shanti Nagar, Gujarat", DOB 1988-04-12. **One org-level record, seen at both premises.** |
| P_RAHUL | A | Rahul Deshmukh, +91 98000 00002; **no address** |
| P_SUNITA_DUP | A | "Sunita Patel", **Sunita's phone**; created at A_MH, with one GLV procedure use there. A likely duplicate of P_SUNITA (merge tests, D-36). |
| P_ROHAN | A | "Rohan Patil", **Sunita's phone** (a family member). Never proposed as her duplicate. |
| P_AYESHA | B | Ayesha Shaikh, +91 98000 00003 |
| DOC_A1 | A | `INTERNAL`; Dr. Meera Kulkarni; registration G-12345, "Gujarat Medical Council"; address NULL (so the premises' address is used) |
| DOC_A2 | A | `INTERNAL`; Dr. Arjun Rao; **no `registration_no`** |
| DOC_EXT | A | `EXTERNAL`; Dr. Kavita Joshi; registration and address present |
| DOC_B1 | B | `INTERNAL`; Dr. Farhan Qureshi; registration present |
| PT_PEEL / PT_B | A / B | procedure types |
| SUP_LIC | A | Medline Distributors; licences `{20B/AHM/0001, 21B/AHM/0001}`, valid till 2028-12-31 |
| SUP_NOLIC | A | Local Traders; no licence |
| SUP_B | B | licensed |
| NONEXIST | — | a random UUID that was never inserted |

### Prescription records (org A unless stated; recorded at A_GJ, prescribed 2026-10-06)

| Handle | Source | Prescriber → patient | Evidence | Lines (`item_id`, `qty_base_prescribed`) |
|---|---|---|---|---|
| RX_S1 | MANUAL | DOC_A1 → P_SUNITA | **verified by A1** | L_AZI (AZI, 3) · L_ISO (ISO, **30**) · L_ACI (ACI, **20**) · L_PCM (PCM, 15). `serial_text` "SE/1042". |
| RX_S1_PHOTO | PHOTO, 1 image | DOC_A1 → P_SUNITA | **photo**, unverified | L_ISO2 (ISO, 10), transcribed by AF |
| RX_S1_BARE | MANUAL | DOC_A1 → P_SUNITA | **none** (no photo, unverified) | L_ISO3 (ISO, 10) |
| RX_S1_NOQTY | MANUAL | DOC_A1 → P_SUNITA | verified | L_ISO4 (ISO, **NULL**) |
| RX_S1_EMPTY | PHOTO, **no image** | DOC_A1 → P_SUNITA | — | L_PCM5 (PCM, 15) |
| RX_S1_VOID | MANUAL, **VOID** | DOC_A1 → P_SUNITA | verified | L_ISO6 (ISO, 10) |
| RX_A2 | MANUAL | DOC_A2 → P_SUNITA | verified by A2 | L_PCM7 (PCM, 15) |
| RX_R1 | MANUAL | DOC_A1 → **P_RAHUL** | verified | L_ISO8 (ISO, 10) |
| RX_B1 | MANUAL (org B) | DOC_B1 → P_AYESHA | verified | one line |

### Items in org A (B has `_B` mirrors at LOC_B_GJ)

| Handle | Category | Units | Flags (test data) | Batches: on hand per location |
|---|---|---|---|---|
| PCM | MEDICINE | TABLET; strip = 15, box = 150; reorder level 20 | — | LOC_A_GJ: `PCM-OLD` exp 2026-09-30 (**expired**, received before it expired) 15 · `PCM-DEC` 2026-12-31 15 · `PCM-MAR` 2027-03-31 30. LOC_A_GJ_Q: `PCM-Q` exp 2026-08-31, **imported already expired** (D-14) 12. LOC_A_MH: `PCM-MAR` 22. MRP ₹45.00 per strip. |
| AZI | MEDICINE | TABLET; strip = 3; reorder level 2 | **H1** | `AZI-1` 2027-06-30: **3** at LOC_A_GJ |
| ISO | MEDICINE | CAPSULE; strip = 10; master ISOTRETINOIN 20 MG CAP | H; item **`requires_prescription = true`** (from the master seed, D-32) | `ISO-T` exp **2026-10-07** (today) 10 · `ISO-1` 2027-01-31 20, both at LOC_A_GJ |
| ACI | MEDICINE | CAPSULE; master ACITRETIN 25 MG CAP | item **`requires_prescription = true`** (from the master seed) | `ACI-1` 2027-04-30: **30** at LOC_A_GJ |
| NDX | MEDICINE | TABLET | **NDPS** | none |
| SCX | MEDICINE | TABLET (generic METHYLPHENIDATE) | **X** | none |
| SUN | RETAIL_PRODUCT | G; tube = 50 (dispensable unit: tube) | — | `SUN-1` 2027-08-31: 500 at LOC_A_GJ. MRP ₹650 per tube. |
| GLV | CONSUMABLE (untracked) | PIECE; box = 100 | — | no batch: 200 at LOC_A_GJ, 100 at LOC_A_MH |
| TOX | INJECTABLE | UNIT; vial = 100; **container unit = vial, `in_use_hours` = 24** (P1-C) | H | `TOX-1` exp 2026-10-07: 200 · `TOX-2` 2027-05-31: 100, both at LOC_A_GJ |

**Batches are per premises** (06a §2.6): `PCM-MAR` at A_GJ and `PCM-MAR` at A_MH are two batch rows with the same number and expiry.

**How stock is seeded.** Seeded stock comes from `OPENING_BALANCE` movements written **through the service**, with `occurred_at = 2026-09-01 09:00 IST`. The exception is `PCM-Q`, imported on 2026-10-01, which therefore lands in quarantine.

**Prescriptions in stock rows.** **ISO and ACI dispenses in §11–§23 link RX_S1's L_ISO / L_ACI** (MR-18) unless the row says otherwise.

---

## 3. Harness contract

- **Two connection kinds.**
  - **Migrator:** owns the tables; applies migrations; truncates between tests.
  - **App:** every test request uses this role, so **RLS is exercised in every row**, not only in §4.
- **`as(handle, {device})`:**
  - signs in through A-02 on the given device (`DEV_*` cookie, or `UNTRUSTED`);
  - sets the switch PIN if needed;
  - returns a client with cookies.

  Results are cached per test file.
- **`switchTo(device, handle)`:** A-11 with that person's switch PIN.
- **`grant(client, purpose, entityId)`:** A-12 with the person's signing PIN; returns the grant id to send.
- **Clock:** `frozenClock(istIso)` and `advance(minutes)` pin `lib/clock.ts`.
- **`assertIdentical404(a, b)`:** same status, same body shape, same `code`.
- **`ledgerSnapshot(tenant)`:** `{(item, batch, location): (Σ qty_delta, cached on_hand)}`, plus row counts of every tenant table. Used for "nothing changed" assertions.
- **`captureLogs()`:** every log line emitted during the test.
- **`fakeOtpChannel`:** records each send (`phone_hmac`, channel, code). A test reads the code from it.
- **Grants by default.** A row whose operation needs a signing-PIN grant (06a §3.7) sends a matching one, unless the row tests its absence.
- **Test pepper.** The harness sets a fixed, test-only `PIN_PEPPERS`. It is never a production value (DPN-15 … 17).
- **Concurrency rows** fire requests in parallel over separate pool connections. The pool's `max: 8` is respected, and queuing is allowed.

---

## 4. RLS and role self-tests (gates PR 0 and PR 1)

| ID | Scenario | Expected |
|---|---|---|
| DS-01 | as the app role, outside `withTenant`: `SELECT count(*)` on every table with `org_id`, and on `organisations` | **0** rows each (fail-closed) |
| DS-02 | as the app role, outside `withTenant`: INSERT into `suppliers` with `org_id = A` | RLS `WITH CHECK` violation |
| DS-03 | inside `withTenant(A)`: INSERT a row with `org_id = B` | `WITH CHECK` violation |
| DS-04 | inside `withTenant(A)`: SELECT every tenant table | only `org_id = A` rows (asserted by id-set against seeded B rows) |
| DS-05 | after `withTenant(A)` commits, the same pooled connection runs a query outside `withTenant` | 0 rows (the setting did not leak) |
| DS-06 | the same as DS-05 after a **rollback** | 0 rows |
| DS-07 | introspection: every table with `org_id`, and `organisations` | `relrowsecurity` **and** `relforcerowsecurity`, with the `tenant_isolation` policy. The list comes from the catalog, not a hard-coded list. |
| DS-08 | introspection: the app role | `rolsuper = false`, `rolbypassrls = false`; owns no table, sequence or function |
| DS-09 | start the app connected as a **superuser** (a test-only DSN) | every `/api/*` route except `/api/health` → 503 `SCHEMA_UNVERIFIED`, sign-in included; the log names the failed check |
| DS-10 | `ALTER TABLE stock_movements NO FORCE ROW LEVEL SECURITY` (migrator), then call any route | 503 `SCHEMA_UNVERIFIED` |
| DS-11 | inside `withTenant(A)`: insert via SQL a dispense naming `prescriber_id = DOC_B1`, `prescription_id = RX_B1` or `patient_id = P_AYESHA` | composite-FK violation in each case; no `assert_same_org` trigger exists (introspection) |
| DS-12 | the staging deploy's service environments | the web `DATABASE_URL` user is `pharmacy_app`; `MIGRATION_DATABASE_URL` is `pharmacy_migrator`; the cron service is `pharmacy_jobs`. **No service holds a superuser DSN.** |
| DS-13 | `auth_resolve_org()` as the app role | `org-a` → A's id and display name only; an unknown slug → no row; a `SUSPENDED` organisation → no row; the function returns no other column |
| DS-14 | policy inventory, from the catalog | every policy is `tenant_isolation`, or one of `org_directory` (on `organisations`), `curation_select` / `curation_update` (on `master_correction_requests`). Adding any other makes the self-check fail. |
| DS-15 | as `pharmacy_jobs` | SELECT `organisations` → every `ACTIVE` organisation; SELECT `stock_movements` outside `withTenant` → 0 rows |
| DS-16 | as `pharmacy_curator` | UPDATE `medicine_master` succeeds; SELECT `patients` → `insufficient_privilege` |
| DS-17 | as `pharmacy_resolver` (via `SET ROLE` in the harness) | SELECT on any table other than four columns of `organisations` → `insufficient_privilege` |
| DS-18 | **catalog: keys and unique constraints** (06a §2.6) | Derived from `pg_constraint` and `pg_index`, not a hand-written list:<br>• every tenant table's primary key is `(org_id, id)`;<br>• every unique constraint and unique index on a tenant table includes `org_id`;<br>• for per-premises rows, the uniques 06a §2.6 lists also include `premises_id`.<br>Anything else must be on the reviewed exception list (DMG-14). |
| DS-19 | **catalog: foreign keys** | • Every FK between tenant tables starts with `org_id` and references a key that starts with `org_id`.<br>• Every FK from a batch- or location-naming row includes `premises_id`.<br>• FKs to non-tenant tables appear only on the reviewed list (`organisations`, `medicine_master`). |
| DS-20 | **a cross-tenant foreign-key insert fails** (generated: one sub-row per FK in the catalog) | Inside `withTenant(A)`, insert a child row whose reference names org B's matching parent row (ids read by the migrator from B's seed) → a foreign-key violation (`23503`), every time. There is a fixture builder per table; an FK without one fails this test, so a new FK cannot skip it. |
| DS-21 | **a duplicate value in another organisation is not a unique violation** (generated: one sub-row per unique constraint) | Insert into B a row whose key columns (other than `org_id`) copy an A row → succeeds. The same insert into A → a unique violation.<br>Named samples that must be among them: login `af`; a patient's phone; a supplier's name and GSTIN; an item's display name; an invoice number; a batch number + expiry; an idempotency key; the role key `store`; a device name; a procedure-type name; a location name. |

---

## 5. Cross-tenant isolation matrix (one row per endpoint)

**Defaults for every row:**
- **Actor:** org A's owner **AA**, signed in on DEV_A_GJ, holding every permission at every premises (and a signing-PIN grant where the route needs one), unless the row says otherwise.
- **Target:** org B's resource.

**Every row asserts:**
- `assertIdentical404` against the same call with `NONEXIST`;
- `ledgerSnapshot(B)` unchanged.

**Every write row also asserts:**
- `ledgerSnapshot(A)` unchanged;
- no new outbox, idempotency, audit or re-auth rows in either tenant.

DX-76 fails the build if any route lacks a row here.

| ID | Endpoint | Target (org B) | Expected |
|---|---|---|---|
| **Sign-in and session** | | | |
| DX-01 | A-01 `GET /auth/context` | `?org=org-b`; and DEV_B_GJ's device cookie re-signed with a wrong key | B's display name only, never an id; the forged cookie is ignored (context = no device) |
| DX-02 | A-02 sign-in on DEV_A_GJ with BA's login and password | — | 401 `invalid_credentials`, identical in body and timing class to an unknown login; BA's counters unchanged |
| DX-03 | A-03 / A-04 / A-05 OTP on DEV_A_GJ with BA's phone | — | 202 like any number; `fakeOtpChannel` records no send to BA; verify never succeeds |
| DX-04 | A-06, A-07, A-08, A-09, A-13 … A-16 (self-only) | a body naming another user or session | 422 (unknown key); responses carry only the caller's organisation |
| DX-05 | A-10 lock-screen list on DEV_A_GJ while BA is signed in on DEV_B_GJ | — | only A's sessions on DEV_A_GJ |
| DX-06 | A-11 switch on DEV_A_GJ to BA's session id, with BA's correct switch PIN | — | 404 `SESSION_NOT_FOUND`, identical to `NONEXIST`; BA's PIN counter unchanged |
| DX-07 | A-12 a grant naming B's document as `entityId`, then E-35 on that document | — | the grant is issued (entities are not looked up at grant time); E-35 → 404; the grant stays unused |
| DX-08 | an A session cookie presented with DEV_B_GJ's device cookie; an A cookie re-signed with `org = B` under a wrong key | — | 401 `device_mismatch`; 401 `unauthenticated` |
| **Administration** | | | |
| DX-09 | M-01 org settings | — | reads and writes A's only; B's `version` unchanged |
| DX-10 | M-02 `GET /premises` | — | A_GJ and A_MH only |
| DX-11 | M-03 create a premises | — | the new row has `org_id = A`; B's M-02 does not list it |
| DX-12 | M-04 `PATCH /premises/{id}` | B_GJ | 404 `PREMISES_NOT_FOUND`; unchanged |
| DX-13 | M-05 list; create with `premisesIds = [B_GJ]` | — | the list excludes BA; create → 404 `PREMISES_NOT_FOUND`, no staff row |
| DX-14 | M-06 `GET` / `PATCH /staff/{id}` | BA | 404 `STAFF_NOT_FOUND`; unchanged |
| DX-15 | M-07 reset | BA | 404; BA's hashes unchanged |
| DX-16 | M-08 revoke sessions | BA | 404; BA still signed in |
| DX-17 | M-09 list roles; `PATCH /roles/{key}` for a role that exists only in B | — | A's roles only; 404 `ROLE_NOT_FOUND`; B's grants unchanged |
| DX-18 | M-10 list devices; M-11 revoke | DEV_B_GJ | A's devices only; 404 `DEVICE_NOT_FOUND`; DEV_B_GJ still trusted |
| DX-19 | M-12 audit; `?staffId=BA` | — | A's rows only; empty |
| **People and prescriptions** | | | |
| DX-20 | P-01 `?q=Ayesha`; `?phone=+919800000003` | — | empty (identical to a random name) |
| DX-21 | P-02 create "Ayesha Shaikh" with B's patient's phone | — | 201 in A with **no** `POSSIBLE_DUPLICATE` warning (B's patient is never a candidate) |
| DX-22 | P-03 `GET` / `PATCH` | P_AYESHA | 404 `PATIENT_NOT_FOUND`; unchanged |
| DX-23 | P-04 list; P-05 `GET` / `PATCH` | DOC_B1 | A's only; 404 `PRESCRIBER_NOT_FOUND` |
| DX-24 | P-06 `?patientId=P_AYESHA`; the unfiltered list | — | empty; excludes RX_B1 |
| DX-25 | P-07 create with `patientId = P_AYESHA`, or `prescriberId = DOC_B1`, or `premisesId = B_GJ` (one sub-row each) | — | 404 for each; nothing created |
| DX-26 | P-08 `GET` | RX_B1 | 404 `PRESCRIPTION_NOT_FOUND` |
| DX-27 | P-09 add a line to RX_B1; add a line to RX_S1 with `itemId = PCM_B` | — | 404; 404 `ITEM_NOT_FOUND` |
| DX-28 | P-10 upload an image | RX_B1 | 404; no image row |
| DX-29 | P-11 B's image via RX_B1's id; B's image id under RX_S1's id | — | 404 both; no bytes returned |
| DX-30 | P-12 verify | RX_B1 | 404 |
| DX-31 | P-13 void | RX_B1 | 404; still `ACTIVE` |
| DX-32 | P-14 list; `PATCH` | PT_B | A's only; 404 `PROCEDURE_TYPE_NOT_FOUND` |
| DX-78 | P-15 likely duplicates, while B also has a patient with Sunita's name and phone | — | pairs within A only; B's patient never appears |
| DX-79 | P-16 merge with `mergedId = P_AYESHA`, or `survivorId = P_AYESHA` | — | 404 `PATIENT_NOT_FOUND`; no `patient_merges` row in either organisation |
| DX-80 | P-17 undo | B's merge | 404 `MERGE_NOT_FOUND`; B's merge still in force |
| **Stock** | | | |
| DX-33 | E-01 / E-02 / E-03 settings | — | reads and writes A's only; E-02 on a configured A → 409 `ALREADY_CONFIGURED`; B's row unchanged |
| DX-34 | E-04 `GET /dispensary/premises` | — | A_GJ and A_MH only |
| DX-35 | E-05 / E-06 premises setup / settings | B_GJ | 404 `PREMISES_NOT_FOUND`; B's settings `version` unchanged |
| DX-36 | E-07 `PATCH /locations/{id}` | LOC_B_GJ | 404 `LOCATION_NOT_FOUND` |
| DX-37 | E-08 / E-09 master | — | 200, the same global rows for every organisation (no tenant data) |
| DX-38 | E-10 a correction; E-11 the list | — | the row has `org_id = A`; B's E-11 does not list it |
| DX-39 | E-12 `GET /items`; E-13 create | — | the id-set excludes every `_B` item; the new item has `org_id = A` and is absent from B's E-12 |
| DX-40 | E-14 `GET /items/{id}` | PCM_B | 404 `ITEM_NOT_FOUND` |
| DX-41 | E-15 `PATCH /items/{id}` | PCM_B | 404; unchanged |
| DX-42 | E-16 add a unit; E-17 patch a unit | PCM_B; PCM_B's strip | 404; no unit created |
| DX-43 | E-18 movements | PCM_B | 404 |
| DX-44 | E-19 tax rates | — | excludes B's rows |
| DX-45 | E-20 list suppliers; E-21 `GET` / `PATCH` | SUP_B | excludes SUP_B; 404, unchanged |
| DX-46 | E-23 create a GRN with `supplierId = SUP_B`; a line with `itemId = PCM_B`; `premisesId = B_GJ` (one sub-row each) | — | 404 `SUPPLIER_NOT_FOUND` / `ITEM_NOT_FOUND` / `PREMISES_NOT_FOUND`; no draft |
| DX-47 | E-23 list; E-24 `GET` / `PATCH` | B's draft | excludes B's; 404 |
| DX-48 | E-25 post | B's draft | 404; B's GRN still `DRAFT`; no movements |
| DX-49 | E-26 discard | B's draft | 404; still `DRAFT` |
| DX-50 | E-27 preview with `patientId = P_AYESHA` | — | 404 `PATIENT_NOT_FOUND`, identical to `NONEXIST` |
| DX-51 | E-28 dispense with `patientId = P_AYESHA` | — | 404; no dispense; no movement |
| DX-52 | E-28 `prescriberId = DOC_B1` | — | 404 `PRESCRIBER_NOT_FOUND` |
| DX-53 | E-28 `prescriptionId = RX_B1`; RX_S1 with a `prescriptionLineId` of RX_B1 | — | 404 `PRESCRIPTION_NOT_FOUND`, identical to `NONEXIST`; 404 `PRESCRIPTION_LINE_NOT_FOUND` |
| DX-54 | E-28 a line with `itemId = PCM_B`; a manual allocation on B's batch | — | 404 `ITEM_NOT_FOUND`; 404 `BATCH_NOT_FOUND` |
| DX-55 | E-28 `premisesId = B_GJ`, or `locationId = LOC_B_GJ` | — | 404 `PREMISES_NOT_FOUND` / `LOCATION_NOT_FOUND` |
| DX-56 | E-28a `dispensable` | RX_B1 | 404 `PRESCRIPTION_NOT_FOUND` |
| DX-57 | E-29 `?patientId=P_AYESHA`; `?prescriptionId=RX_B1`; the list | — | 200, **empty** (identical to a random id); excludes B's |
| DX-58 | E-30 `GET /dispenses/{id}` | B's | 404 `DISPENSE_NOT_FOUND` |
| DX-59 | E-31 a procedure use with `procedureTypeId = PT_B` or `patientId = P_AYESHA`; `GET` B's | — | 404 `PROCEDURE_TYPE_NOT_FOUND` / `PATIENT_NOT_FOUND`; 404 |
| DX-60 | E-32 a return with B's `dispenseId`; A's dispense with B's `dispenseAllocationId`; `GET` B's | — | 404 `DISPENSE_NOT_FOUND` / `ALLOCATION_NOT_FOUND` / 404 |
| DX-61 | E-33 a supplier return with SUP_B or B's batch; `GET` B's | — | 404 |
| DX-62 | E-34 an adjustment on B's batch; `GET` B's | — | 404; B's `on_hand` unchanged |
| DX-63 | E-35 a reversal of B's dispense, GRN, return, adjustment, import and procedure use (one sub-row each); the list | — | 404 `DOCUMENT_NOT_FOUND`; no `stock_reversals` row; the list excludes B's |
| DX-64 | E-36 the containers list; E-37 discard B's container (P1-C) | — | excludes B's; 404 |
| DX-65 | E-38 alerts | — | excludes B's events |
| DX-66 | E-39 every report; then with `premisesId = B_GJ` | — | A's ids and totals only; 404 `PREMISES_NOT_FOUND` |
| DX-67 | E-40 the H1 register with `premisesId = B_GJ`; A's register | — | 404; A's register never contains P_AYESHA or DOC_B1 |
| DX-68 | E-40 the purchase register | — | never SUP_B's lines |
| DX-69 | E-41 an import with `locationId = LOC_B_GJ`; A's own import | — | 404; A's import has `org_id = A` |
| DX-70 | E-42 `GET` B's import and its rows | — | 404 `IMPORT_NOT_FOUND` |
| DX-71 | E-43 an A row with `matchedItemId = PCM_B` | — | 404 `ITEM_NOT_FOUND` |
| DX-72 | E-44 validate / commit / abandon B's import | — | 404; status unchanged |
| **Across all routes** | | | |
| DX-73 | any write body carrying an extra `orgId` | — | 422; **no request schema accepts `orgId`** (introspection over every route's validator) |
| DX-74 | **Symmetry:** DX-22, DX-26, DX-40, DX-51, DX-58 and DX-63 repeated as **BA** against A's resources | | 404 identical to `NONEXIST`; A unchanged |
| DX-75 | any route as AX (deactivated); every stock route as AN (no premises) | | 401 `session_revoked`, with no tenant query run; 404 `PREMISES_NOT_FOUND` on premises-scoped routes and empty lists elsewhere |
| DX-76 | **Route inventory:** every method of every `app/api/**/route.ts` | | has an entry in the route table **and** at least one DX row in this file (the test reads both; a new route without a row fails the build) |
| DX-77 | **Route gate:** every route method | | driven as `owner`, `doctor`, `reception`, `store`, and a custom role with no grants: each gets exactly what §4.2 and the route table say (403 `forbidden` otherwise) |

---

## 6. Permissions within an organisation, and premises scope (D-1, D-2, D-13, D-17)

| ID | Actor | Operation | Expected |
|---|---|---|---|
| DI-01 | AF (`reception`, A_GJ) | E-12, E-14, and an E-28 dispense for P_SUNITA at **A_GJ** | 200, 200, **201** (reception dispenses by default) |
| DI-02 | AF | E-40 registers; E-34 adjustment; E-35 reversal; E-06 premises settings; M-05 staff; M-12 audit | 403 `forbidden` each |
| DI-03 | A1 (`doctor`) | E-30 on a dispense prescribed by another prescriber of org A | **200**: org-wide visibility (D-1) |
| DI-04 | A1 | E-25 post a GRN; E-34 a write-off | 403 each |
| DI-05 | AS (`store`) | E-12, E-14, E-18, E-25 (post a GRN) | 200 each |
| DI-06 | AS | E-28 dispense; P-07 record a prescription | 403 each |
| DI-07 | AS | E-30 with a **real** A dispense id, and with `NONEXIST`; E-29; E-32 `GET`; E-40; P-01; P-08; P-11 | **all** 403 `forbidden`; the real-id and `NONEXIST` responses are identical (no existence signal) |
| DI-08 | AS | every response from E-12, E-14, E-18, E-23/24, E-31 `GET`, E-36, E-38 and E-39, after a full seeded flow (dispenses and procedure uses for Sunita and Rahul) | **no field holds a patient id**, and no string contains "Sunita", "Patil", "Rahul", "Deshmukh" or "98000" |
| DI-09 | AA | every Phase 1 endpoint, at both premises | never 403 or 404 for org A resources |
| DI-10 | AX (deactivated) | every endpoint | 401 `session_revoked` on the **next request** after deactivation, with no other change |
| DI-11 | *(withdrawn: there is no shared login in this app)* | | |
| DI-12 | AF, after AA sets the override `reception: stock.dispense = false` (M-09, with a grant) | E-28 | 403. A `role.grant_changed` audit row exists in the same transaction. Restoring the grant → 201. Org B is unaffected. |
| DI-13 | A1 | E-31 `GET` of a procedure use linked to P_SUNITA | the patient link is present (A1 has `dispense.view`); the same call as AS omits it |
| **Premises scope (D-17)** | | | |
| DI-14 | AF (A_GJ only) | E-12 / E-14 with `premisesId = A_MH`; E-28 at A_MH; E-23 a GRN at A_MH; P-07 a prescription at A_MH | **404 `PREMISES_NOT_FOUND`**, identical to a nonexistent premises |
| DI-15 | AF | E-14 for PCM with no `premisesId` | balances for **A_GJ only**; A_MH's 22 tablets are not shown |
| DI-16 | AF | E-29 `?patientId=P_SUNITA` after a dispense at A_GJ and a procedure use at A_MH (by AM) | **both** listed: patient history is org-wide |
| DI-17 | AM (A_MH only) | E-28 at A_GJ | 404 `PREMISES_NOT_FOUND` |
| DI-18 | AA | E-39 stock overview with no `premisesId` | totals equal A_GJ + A_MH (the owner's combined view) |
| **Prescriptions** | | | |
| DI-19 | A1 (linked to DOC_A1) | P-12 verify RX_S1_PHOTO (prescriber DOC_A1), with a grant | 200 |
| DI-20 | A2 (linked to DOC_A2), and AA (no prescriber link) | P-12 verify RX_S1_PHOTO | 403 `not_the_prescriber` each; AF → 403 `forbidden` |
| DI-21 | AA | M-09 removing `org.settings`, `staff.manage` or `roles.manage` from `owner` | 422 `OWNER_GRANT_LOCKED` |
| DI-22 | AF and A1 (no `patients.merge`); then AA | P-15; P-16 | 403 `forbidden` each; AA with a `patients.merge` grant → 201 |

---

## 7. Sign-in and sessions (DN)

| ID | Scenario | Expected |
|---|---|---|
| DN-01 | AF signs in with the right password on DEV_A_GJ | a session with `device_id = DEV_A_GJ`; the `pharm_session` cookie is httpOnly, `secure` and `sameSite=lax`; `auth.sign_in_succeeded {method: password}` is audited in the same transaction |
| DN-02 | an unknown login | 401 `invalid_credentials`; one dummy scrypt verify (asserted by call count); the typed login appears in no log or audit row |
| DN-03 | 5 wrong passwords for AF from UNTRUSTED; then the right password; then OTP | the 5th pauses password sign-in for 15 min. During the pause, the right password → 401 `invalid_credentials` (no oracle); AF's existing sessions keep working; OTP sign-in succeeds. |
| DN-04 | 30 parallel wrong passwords for AF from UNTRUSTED | at most 5 password checks run (try taken before check) |
| DN-05 | 5 wrong passwords for AF on DEV_A_GJ, then a 6th | the account is not paused by the first 5; from the 6th, that device counts as untrusted for AF (the attempt counts toward the account pause) |
| DN-06 | the 21st failed sign-in from one IP within 15 min | 429 `too_many_attempts` with `Retry-After` |
| DN-07 | **daily expiry:** AF signs in at 2026-10-07 13:00 IST; then a request at 2026-10-08 04:00:01 IST. Also a sign-in at 2026-10-07 10:00. | `expires_at` = 2026-10-08 04:00 IST; the request → 401 `session_expired`. The 10:00 sign-in expires at 2026-10-08 02:00 (the 16-hour cap comes first). |
| DN-08 | `day_reset_time_ist` set to 02:00 (data, no deploy), then a sign-in at 13:00 | expires 2026-10-08 02:00; existing sessions keep their stored `expires_at` |
| DN-09 | AA deactivates AF | AF's next request on any device → 401 `session_revoked` |
| DN-10 | AA changes AF's role | AF's sessions are revoked (`role_changed`) |
| DN-11 | AA removes AF's A_GJ membership | AF's next stock request at A_GJ → 404 `PREMISES_NOT_FOUND`; the session is **not** revoked |
| DN-12 | any authenticated request | the guard's lookup is **one** SQL statement (query count asserted) |
| DN-13 | a new staff member's first sign-in with a one-time password | every route except `/api/auth/*` and A-13 → 403 `password_change_required` until changed |
| DN-14 | AF changes their password | AF's other sessions are revoked (`password_changed`); this one stays |
| DN-15 | AF signs out on DEV_A_GJ | the session is revoked; the lock screen no longer lists AF |
| DN-16 | a JWT with a wrong key, an expired `exp`, or `v ≠ 1` | 401 `unauthenticated` |
| DN-17 | AA resets AF (M-07, with a grant) | a one-time password is returned **once**; both PINs are cleared; all AF's sessions are revoked; `staff.password_reset` is audited; the password appears in no log or audit row |
| DN-18 | AA is the only active owner: deactivate or demote AA | 409 `last_owner` |
| DN-19 | UNTRUSTED with `untrusted_idle_minutes` NULL: no input for 5 h. Then the setting is 30: no input for 31 min. | still signed in; then 401 `session_idle` and revoked (`idle`) |
| DN-20 | a `SUSPENDED` organisation | sign-in → 401 `invalid_credentials`; live sessions → 401 `session_revoked` on the next request |
| DN-21 | the founder CLI creates org C | the organisation, its first premises, its built-in roles and an owner with `must_change_password`; the one-time password is printed once; `org.created` and `staff.owner_bootstrapped` are audited |

---

## 8. Trusted devices, switching and the idle lock (DW)

| ID | Scenario | Expected |
|---|---|---|
| DW-01 | AA trusts a new PC (M-10) without a grant; then with a `devices.register` grant | 401 `reauth_required`; then a device row and the `pharm_device` cookie (httpOnly, signed); `auth.device_registered` audited |
| DW-02 | AF and A1 both sign in on DEV_A_GJ | both sessions are live; the second sign-in does **not** revoke the first; A-10 lists both, name and role only |
| DW-03 | lock → pick A1 → A1's switch PIN | A1's session becomes active; the cookie is reissued; `auth.switched {device_id, from_session_id, to_session_id}` audited |
| DW-04 | a dispense after DW-03 | `actor_staff_id` = A1 (the active person) |
| DW-05 | after DW-03, a request carrying AF's old cookie (a second tab) | 401 `device_locked`; no write |
| DW-06 | no input for 3 min, then a GET and a POST | both → 401 `device_locked`; `device_state.active_session_id` is NULL; both sessions still live; A-10 still lists both |
| DW-07 | GET polls every 10 s for 5 min with no input | the device still locks at 3 min (polls are not input) |
| DW-08 | activity pings every 30 s for 10 min, then none | no lock while pinging; it locks 3 min after the last ping |
| DW-09 | a POST sent at lock time + 1 s from a tab that has sent no ping since | 401 `device_locked`; `ledgerSnapshot(A)` unchanged |
| DW-10 | `device_lock_minutes` set to 5 (data); then to 0 and to 11 | locks at 5 min; 0 and 11 → 422 |
| DW-11 | within 15 min, 3 wrong switch PINs for AF on DEV_A_GJ and 2 on DEV_A_GJ2 | AF's PIN switching is blocked on both devices (403 `switch_pin_blocked`). A1 is unaffected; AF's sessions are not revoked. AF's next full sign-in (password or OTP) clears the block. |
| DW-12 | 4 wrong switch PINs, then 1 more 16 min after the first | not blocked (the window slid) |
| DW-13 | 30 parallel wrong switch PINs for AF | at most 5 PIN checks run |
| DW-14 | A-10 / A-11 from UNTRUSTED | 401 `device_required`; the UI offers no lock screen |
| DW-15 | AA revokes DEV_A_GJ | every session on it → 401 `session_revoked` on the next request; the cookie no longer opens the lock screen |
| DW-16 | a person with no switch PIN signs in on DEV_A_GJ | every route except A-14 and sign-out → 403 `switch_pin_required` until it is set |
| DW-17 | a session from DEV_A_GJ presented with DEV_A_MH's cookie | 401 `device_mismatch` |
| DW-18 | AF signs in again on DEV_A_GJ while their earlier session there is open | the old session is revoked (`replaced`) and the new one is active; A1's session is untouched |
| DW-19 | A-09 "Switch person" | the device locks at once; the next request → 401 `device_locked` |
| DW-20 | an A-11 switch to a session whose `expires_at` has passed | 401 `session_expired`; that person must sign in fully |

---

## 9. PINs and re-auth (DPN)

| ID | Scenario | Expected |
|---|---|---|
| DPN-01 | set the switch PIN equal to the signing PIN, and the other way round | 422 `PIN_SAME_AS_OTHER` both ways |
| DPN-02 | A-15 set the signing PIN without a password or an OTP in the request | 422 `CREDENTIAL_REQUIRED`; with the wrong password → 401 `wrong_secret`, counted against the session |
| DPN-03 | PIN quality: `000000`, `123456`, `654321`, `12345`, `1234567`, `12a456` | 422 `PIN_FORMAT` each |
| DPN-04 | a `stock.reverse` grant for dispense D1, used to reverse D1 | 201. A second use → 401 `reauth_required`; use for D2 → 401; use after 2 min → 401; use from another session → 401. |
| DPN-05 | the **switch** PIN sent to A-12 | 401 `wrong_secret`; counts against the session |
| DPN-06 | the account password sent to A-12 | a grant is issued |
| DPN-07 | 5 wrong secrets on A-12 in one session | the 5th ends that session (401 `session_revoked`); the person's other sessions and switch-PIN counter are unaffected |
| DPN-08 | every purpose in 06a §3.7 (one sub-row each) | the operation without a grant → 401 `reauth_required`; with a matching grant → success; with a grant for another purpose or entity → 401 |
| DPN-09 | direct SQL: a grant with `expires_at > created_at + 10 min` | CHECK violation |
| DPN-10 | a reversal that fails with 409 `INSUFFICIENT_STOCK` after taking a grant; then the stock is restored and the same grant is retried | the first leaves the grant unused (rolled back with the transaction); the retry → 201 |
| DPN-11 | route introspection | dispense, preview, GRN, procedure use (without an override), patient return and every read consume no grant |
| DPN-12 | **backdating past the reason-free lag (D-33):** AF records a dispense 3 h late with a reason, first without a grant, then with a `stock.backdate` grant. Then a dispense 90 min late with no reason and no grant. | 401 `reauth_required`; 201; 201 (within the lag, no grant is needed). The same for a procedure use, a patient return and a GRN `receivedAt`. |
| DPN-13 | **stock-count adjustment (D-33):** a `STOCKTAKE_ADJUSTMENT` without a grant; with a `stock.adjust` grant | 401 `reauth_required`; 201 |
| DPN-14 | **who gets a signing PIN (D-33):**<br>• AS (`store`, no PIN-gated permission) calls A-15;<br>• AF's role loses `stock.backdate` by an override (M-09), and AF had a signing PIN;<br>• a doctor with no signing PIN tries a gated action. | 403 `signing_pin_not_applicable`; AF's `signing_pin_hash` is NULL after the change (same transaction, audited); 409 `signing_pin_not_set` |
| DPN-15 | **pepper (D-34):** a stored switch-PIN hash checked with the right PIN but a different pepper | fails. The hash text carries its `p<v>` version. No column, setting, migration or log line contains the pepper (introspection + `captureLogs()`). |
| DPN-16 | **routine rotation:** `PIN_PEPPERS` = v1; PINs set; v2 added and the app restarted; AF switches with the right PIN. Then the runbook's step 4 retires v1. | The switch succeeds, and AF's hash is now `p2` (re-hashed in the same transaction); the weekly count for v1 drops by one. Retiring v1 clears the remaining v1 hashes and audits `auth.pin_pepper_retired`; those people are asked to set a PIN after their next full sign-in. |
| DPN-17 | the app started with `PIN_PEPPERS` missing, malformed, shorter than 32 bytes, or lacking a version that stored hashes use | it refuses to start and names the failed check, never the value |

---

## 10. Phone OTP (DQ)

| ID | Scenario | Expected |
|---|---|---|
| DQ-01 | AF signs in by OTP on DEV_A_GJ | `fakeOtpChannel` records one WhatsApp send with 6 digits; verify → a session; `auth.otp_sent {channel: whatsapp}` and `auth.sign_in_succeeded {method: otp}` audited |
| DQ-02 | a wrong code 3 times, then the right one | the challenge is dead: 401 `otp_invalid`; a new challenge is needed |
| DQ-03 | the right code after 5 min | 401 `otp_invalid` |
| DQ-04 | an unknown phone | the same 202 shape and status; the handler returns before any provider call in both the known and the unknown case (call order asserted); no send; verify never succeeds |
| DQ-05 | a 6th code for one phone within an hour | 202, identical, but no send |
| DQ-06 | A-05 SMS fallback at 29 s, then at 31 s | 409 `TOO_EARLY`; then one SMS send |
| DQ-07 | `captureLogs()` and an audit scan over DQ-01 … 06 | no phone number and no code anywhere |
| DQ-08 | the `otp_challenges` schema and rows | no column holds a phone or a code in clear |
| DQ-09 | a phone registered in both A and B: OTP sign-in in A's context | a session in A only |
| DQ-10 | OTP sign-in by a person whose switch PIN is blocked (DW-11) | the block is cleared |

---

## 11. Patients, prescribers and prescriptions (DRX)

| ID | Scenario | Expected |
|---|---|---|
| DRX-01 | P-02 with a name only; with phone `98000 00004`; with phone `12345` | 201; 201 with `phoneE164 = +919800000004`; 422 `PHONE_FORMAT` |
| DRX-02 | P-02 "Sunita Patel" with Sunita's phone; P-02 "Kiran Patil" with Sunita's phone | 201 with warning `POSSIBLE_DUPLICATE` listing P_SUNITA and P_SUNITA_DUP (name + phone); 201 with no warning (a different person on a shared phone) |
| DRX-03 | archive P_RAHUL; then search; then an E-28 for P_RAHUL | absent from search; 422 `PATIENT_ARCHIVED`; his history is still readable |
| DRX-04 | migrator: DELETE P_SUNITA after a dispense | FK `RESTRICT` |
| DRX-05 | P-04 an `EXTERNAL` prescriber with no address; the same via SQL | 422 `PRESCRIBER_ADDRESS_REQUIRED`; CHECK violation |
| DRX-06 | P-07 a MANUAL prescription with two lines; dispense against line 1; edit line 1 by SQL; P-09 add line 3 | 201; 201; the trigger rejects the edit; line 3 → 201 |
| DRX-07 | P-10: a JPEG; a PNG named `.jpg`; a PDF; a GIF; a 2 MiB + 1 byte JPEG | 201 with `sha256`; stored as `image/png` (sniffed); 422 `UNSUPPORTED_FORMAT` (PDF and GIF); 413 `FILE_TOO_LARGE` |
| DRX-08 | P-11 as AF; as AS | the bytes are identical to the upload, `Content-Type` is the stored type, and `Cache-Control: no-store`; AS → 403 |
| DRX-09 | A1 verifies RX_S1_PHOTO with a grant; again; without a grant | 200, `verifiedBy = A1`, `prescription.verified` audited in the same transaction; 409 `ALREADY_VERIFIED`; 401 `reauth_required` |
| DRX-10 | void RX_S1_BARE with a reason; void RX_S1 after a dispense; reverse that dispense, then void RX_S1 | 200, `VOID`; 409 `PRESCRIPTION_HAS_DISPENSES`; 200 |
| DRX-11 | P-07 with `prescribedOn` = tomorrow (IST) | 422 `PRESCRIBED_ON_IN_FUTURE` |
| DRX-12 | delete an image of a prescription that has a dispense (SQL as the app role); of one without | the trigger rejects it; allowed only through the service before any dispense |
| DRX-13 | an E-28 line with `prescriptionLineId` and no `itemId` | 422: the item is always named by the human, never filled in from the line |
| DRX-14 | `captureLogs()` over creating Sunita, recording RX_S1 with an image, and dispensing from it | no log line contains a name, phone, medicine text or image byte count paired with a patient |
| DRX-15 | static check | no code imports an OCR, vision or LLM client; `prescription_images.bytes` is selected only by P-11's query |
| DRX-16 | **browser compression (D-35)**, a component test of the upload control: a synthetic 4000 × 3000 photo (~5 MB) and a large PNG screenshot | each upload body is a JPEG ≤ 400 KB with a long edge ≤ 1600 px; the server cap (DRX-07) still rejects 2 MiB + 1 byte whatever the client sends |
| DRX-17 | P-15 likely duplicates | lists (P_SUNITA, P_SUNITA_DUP) with their document counts; never pairs P_SUNITA with P_ROHAN (same phone, dissimilar name) |
| DRX-18 | **merge (D-36):** P-16 merges P_SUNITA_DUP into P_SUNITA, with a grant | One `patient_merges` row; `patient.merged` audited in the same transaction. `ledgerSnapshot(A)` unchanged. **No row** of `dispenses`, `procedure_uses`, `prescriptions`, `patient_returns` or `stock_movements` was updated: their `xmin` values are unchanged. |
| DRX-19 | after DRX-18: E-29 `?patientId=P_SUNITA`; P-01 search for "Sunita"; P-03 of P_SUNITA_DUP; the H1 register | E-29 includes the duplicate's procedure use (read-time resolution); search no longer shows P_SUNITA_DUP; P-03 returns `mergedInto = P_SUNITA`; the register still prints the snapshots taken at supply |
| DRX-20 | after DRX-18: a new dispense naming P_SUNITA_DUP; a prescription recorded for P_SUNITA_DUP before the merge, dispensed for P_SUNITA | 409 `PATIENT_MERGED` with `details.survivorId`; 201 (MR-21 compares canonical ids) |
| DRX-21 | P-17 undo of DRX-18 | the resolution stops and the two histories separate again; no document row touched (`xmin` unchanged); `patient.merge_undone` audited |
| DRX-22 | chains and cycles: merge X into Y, then Y into Z; then Z into X; X into Y while Y is merged; X into X | canonical(X) = Z; 409 `MERGE_CYCLE`; 409 `PATIENT_ALREADY_MERGED` (merge into the end of the chain instead); 422 `MERGE_SAME_PATIENT` |
| DRX-23 | P-16 without a grant | 401 `reauth_required`; no merge row |

---

## 12. Audit log (DAU)

| ID | Scenario | Expected |
|---|---|---|
| DAU-01 | the app role: UPDATE, DELETE, TRUNCATE `audit_log`; the migrator: UPDATE | `insufficient_privilege`; hint `LEDGER_APPEND_ONLY` |
| DAU-02 | the app role: `ALTER TABLE audit_log DISABLE TRIGGER …` | refused (not the owner) |
| DAU-03 | a detail with an integer above 1e9, a free-text value, or a key not on the allow-list; a security change whose audit insert is made to fail | refused before insert; the security change is rolled back with it (transactional) |
| DAU-04 | one of each: sign-in success and failure, OTP sent and failed, switch, device trusted and revoked, PIN set (both kinds), password change, staff create / role change / deactivate / reset, grant change, org settings, premises legal settings, prescription verify and void, register export | exactly one row each, written in the change's own transaction |
| DAU-05 | a patient edit whose audit write is made to fail | the edit commits; one log line with the action name and error code only |
| DAU-06 | M-12 after a full seeded flow | A's rows only, newest first, paginated; a scan finds no patient name, phone or medicine text in any `detail` |

---

## 13. Global master (DG)

| ID | Scenario | Expected |
|---|---|---|
| DG-01 | E-08 / E-09 as AF, A1, AS and BA | 200, the same rows for every organisation |
| DG-02 | route-table introspection | no write route on the master other than `…/corrections` |
| DG-03 | as the app role: `INSERT`/`UPDATE`/`DELETE medicine_master` | `insufficient_privilege` |
| DG-04 | E-10 a correction | a `master_correction_requests` row; the master row and its `version` unchanged; visible to `pharmacy_curator` through `curation_select` |
| DG-05 | the curator adds `H1` to NDX's master flags | A's item shows the new effective flags; existing `dispense_lines.schedule_flags_snapshot` unchanged |
| DG-06 | A sets `extra_schedule_flags = {H1}` on PCM | effective flags `{H1}`; no request field can remove a master flag |
| DG-07 | static check over the seed and import scripts | `medicine_master` is seeded only from sources listed in `data/master/SOURCES.md`, each with a licence note; no brand list without a licence (06 OQ-5) |
| DG-08 | the curator sets `requires_prescription = true` on a master entry already linked to an item | The next dispense of that item needs a prescription line at once (MR-18's backstop), with no deploy. The next daily job sets the item's own flag (DJ-13). Past `requires_prescription_snapshot` values are unchanged. |
| DG-09 | **the flag on items (D-32):** AA sets `requires_prescription` on PCM; then clears it; then tries to clear it on ISO | PCM dispenses need a prescription line; clearing PCM's → 200, audited `item.requires_prescription_changed`; clearing ISO's → 422 `REQUIRES_PRESCRIPTION_IMPOSED` (its master imposes it) |
| DG-10 | direct SQL: set `requires_prescription = false` on SCX (Schedule X); E-13 creates an item linked to an oral isotretinoin master | the trigger raises; the new item has `requires_prescription = true` |
| DG-11 | a data check on the master seed (`data/master/`) | `requires_prescription` is true on every oral isotretinoin and acitretin entry and false on topical forms; the starting values live only in that data file (DH-13 keeps code free of drug names) |

---

## 14. Ledger DB enforcement (DL)

Run **as the app role** unless "migrator" is stated.

| ID | Scenario | Expected |
|---|---|---|
| DL-01 | `UPDATE stock_movements …` (as the app role, and separately as the migrator) | app: `insufficient_privilege`; migrator: hint `LEDGER_APPEND_ONLY`. The row is unchanged. |
| DL-02 | `DELETE FROM stock_movements …` (both roles) | as DL-01; the row is still there |
| DL-03 | migrator: `DELETE FROM items` for an item with movements | FK `RESTRICT`; nothing cascades |
| DL-04 | inside `withTenant`: a direct insert of a movement that would make `on_hand` −1 | `CHECK` violation; the transaction rolls back |
| DL-05 | `TRUNCATE stock_movements` (app role) | `insufficient_privilege` |
| DL-06 | insert `DISPENSE` with `qty_delta = +5` | `CHECK` (sign) |
| DL-07 | insert `DAMAGE_WRITEOFF` with no reason | `CHECK` |
| DL-08 | insert `DAMAGE_WRITEOFF` with reason `OTHER` and no note | `CHECK` |
| DL-09 | a movement for PCM with `batch_id = NULL`; a movement for GLV with a `batch_id` | hint `BATCH_TRACKING_MISMATCH` (both) |
| DL-10 | a movement in A referencing PCM_B's batch (as the migrator, past RLS visibility) | composite-FK violation |
| DL-11 | a dispense in org A with `patient_id = P_AYESHA` (direct SQL) | composite-FK violation |
| DL-12 | the same (`reference_type`, `reference_id`, `movement_type`) twice | unique violation |
| DL-13 | two `REVERSAL`s of the same movement | unique violation |
| DL-14 | a `REVERSAL` with the wrong qty, the wrong batch, or reversing a `REVERSAL` | hint `REVERSAL_MISMATCH` |
| DL-15 | a second `stock_reversals` row for the same document | unique violation |
| DL-16 | `UPDATE dispense_lines` of a `COMPLETED` dispense; `UPDATE dispenses SET status = 'REVERSED'` with no reversal row | the trigger rejects both |
| DL-17 | `UPDATE item_units SET base_units_per_unit = 10`; `UPDATE items SET track_batches = false` on PCM | the trigger rejects both |
| DL-18 | the migrator drops `stock_movements_validate`, then any route is called | 503 `SCHEMA_UNVERIFIED`; restoring the trigger restores service |
| DL-19 | any backstop reached **through the API** (a fault-injected service pre-check) | the mapped 4xx with the right `code`, **never 500**; one `ledger_backstop_fired` log line |
| DL-20 | `UPDATE`/`DELETE` on `stock_settings_history`, `premises_settings_history`, `org_settings_history` | rejected |
| DL-21 | direct SQL: a `DISPENSE` −1 from LOC_A_GJ_Q (`PCM-Q`) | trigger hint `QUARANTINED` |
| DL-22 | direct SQL: a `STOCKTAKE_ADJUSTMENT` −1 at LOC_A_GJ_Q | hint `QUARANTINED` |
| DL-23 | direct SQL: `EXPIRY_WRITEOFF`, `DAMAGE_WRITEOFF` or `SUPPLIER_RETURN` from LOC_A_GJ_Q | accepted |
| DL-24 | direct SQL: an H1-flagged dispense line under a header with `recorded_at − occurred_at = 45 min` and `scheduled_entry_max_minutes_snapshot = 30` | the trigger (L-21) raises `BACKDATE_NOT_ALLOWED_SCHEDULED` |
| DL-25 | direct SQL: a GRN with `received_at` on 2026-10-05 and `invoice_date` 2026-10-06 | CHECK violation |
| DL-26 (P1-C) | direct SQL: an allocation with `lapse_override_reason` but no `lapse_override_by_staff_id`; then a complete pair under the `BLOCK` policy; then a complete pair whose staff user has no prescriber link | CHECK violation; then the trigger raises; then the trigger raises |
| DL-27 | direct SQL: a dispense line whose `prescription_line_id` belongs to a different prescription than its header's | the trigger (L-25) raises |
| DL-28 | direct SQL at A_GJ: a dispense allocation, and its `DISPENSE` movement, naming **A_MH's** `PCM-MAR` batch row | composite-FK violation (L-26) |
| DL-29 | direct SQL: a movement or balance row whose location is LOC_A_GJ and whose batch belongs to A_MH | composite-FK violation |
| DL-30 | direct SQL: a patient-return header at A_MH referencing a dispense made at A_GJ | composite-FK violation |

---

## 15. Property-based ledger tests (`fast-check`)

**Generator:** random sequences of valid operations over 1–3 items, 1–4 batches, two premises, and random expiries around the clock, with clock advances between steps.

The operations:
- GRN post, some with a **backdated `received_at`**;
- dispense, some backdated within the actor's tier, **some for MR-18 items against random prescription lines**;
- procedure use, containers included;
- patient return; supplier return; write-off; adjustment;
- reversal of a random eligible document, **including procedure uses whose container was discarded since**.

| ID | Property | Asserted after every step |
|---|---|---|
| DP-01 | the balance equals the sum of movements | ∀ keys: cached `on_hand == Σ qty_delta` |
| DP-02 | never negative, now **or as of any past time** | ∀ keys: `on_hand ≥ 0`, and the running balance ordered by (`occurred_at`, `seq`) is ≥ 0 at every point. Every rejected operation left the snapshot identical. |
| DP-03 | a reversal restores the exact prior state | The snapshot after `reverse(d)` equals the snapshot just before *d*, plus every later unrelated movement. For a procedure use from a since-discarded container, the reversal plus its paired wastage is net zero on stock, and the container's remaining stays 0. |
| DP-04 | allocation is deterministic | `allocate(c, q, d)` run twice, and with `c` shuffled → identical |
| DP-05 | no use of expired stock | ∀ `DISPENSE`/`PROCEDURE_USE` movements: `batch.expiry_date ≥ ist_date(occurred_at)` |
| DP-06 | the cache is rebuildable | the migrator truncates `stock_balances` and `rebuild_balances` runs → equal to the pre-truncate cache |
| DP-07 | allocation is FEFO-optimal | no allocated batch has a later (expiry, seq) than an eligible batch with remaining stock that was not fully used (FEFO selections only) |
| DP-08 | returns never exceed what was dispensed | ∀ allocations: Σ non-reversed returns ≤ `qty_base` |
| DP-09 (P1-C) | containers are never over-drawn | ∀ containers: Σ draws + wastage ≤ `container_base_units`; no draw at or after `discard_after` |
| DP-10 | quarantine is one-way | no movement out of a `QUARANTINE` location other than the L-20 types |
| DP-11 | backdating respects the tier | Every header whose `recorded_at − occurred_at` is beyond its `reason_after_minutes_snapshot` has a reason, and an actor whose tier covers the lag. No header with an H1/X/NDPS line has a lag beyond its `scheduled_entry_max_minutes_snapshot`. |
| DP-12 | prescribed quantities hold (L-24) | ∀ prescription lines used for MR-18 items: Σ non-reversed dispensed `qty_base` ≤ `qty_base_prescribed` |

**`allocate()` unit tests** (a pure function, no DB):

| ID | Case | Expected |
|---|---|---|
| DA-01 | empty candidates | `Insufficient(0, 0)` |
| DA-02 | an exact fit across 3 batches | a FEFO split |
| DA-03 | same expiry, different seq | lower seq first |
| DA-04 | same expiry and seq | lower `batchId` first |
| DA-05 | expired stock present, non-expired insufficient | `Insufficient(available, expiredOnHand)` |
| DA-06 | an untracked item | a single pseudo-candidate |
| DA-07 | two lines for one item | the second sees the reduced pool |
| DA-08 | a `QUARANTINE` location's balances | never passed to `allocate` (the service filter is asserted) |

---

## 16. Concurrency (DC; real parallel connections)

| ID | Scenario | Expected |
|---|---|---|
| DC-01 | AZI has 3 on hand. **10** concurrent E-28 requests for 1 tablet each, with distinct keys. | Exactly **3** × 201 and **7** × 409 `INSUFFICIENT_STOCK`. `on_hand = 0`. Exactly 3 dispenses, 3 lines, 3 allocations and 3 movements; **no** orphan rows from the 7 failures. |
| DC-02 | the same with 2 tablets each (on hand 3) | exactly 1 × 201; `on_hand = 1` |
| DC-03 | T1 dispenses PCM + AZI while T2 dispenses AZI + PCM (opposite line order), × 50 | no deadlock surfaces as an error; every outcome is a 201 or a clean 409 |
| DC-04 | a GRN post adding AZI stock, concurrent with DC-01 | the final cache equals Σ movements; the CHECK never fires; DP-01 holds |
| DC-05 | two concurrent returns of 5, against the last 5 returnable tablets of one allocation | one 201, one 422 `RETURN_EXCEEDS_DISPENSED` |
| DC-06 | concurrent `reverse(dispense)` and `patient-return(same dispense)` | exactly one succeeds; the other gets 409 `DISPENSE_REVERSED` or 409 `DOCUMENT_HAS_DEPENDENTS` |
| DC-07 | two concurrent posts of the same draft GRN, with different keys | one 200, one 409 `GRN_NOT_DRAFT`; the receipts are posted once |
| DC-08 | a backdated dispense and a current dispense racing for the same batch | the final as-of history is never negative (DP-02); one of them may 409 |
| DC-09 | a backdated AZI GRN receipt and a backdated AZI dispense that draws on it, posted concurrently | Either order leaves history never negative (DP-02). The dispense succeeds only if the receipt committed first; otherwise it gets a clean 409 `INSUFFICIENT_STOCK_AS_OF`. |
| DC-10 | two concurrent ACI dispenses of 15 against L_ACI (20 prescribed; 30 in stock) | one 201, one 409 `RX_QTY_EXCEEDED`; Σ dispensed against L_ACI = 15 |
| DC-11 | on DEV_A_GJ, AF's dispense request and an A-11 switch to A1, started together, × 50 | Every committed dispense has `actor_staff_id = AF`, and committed before the switch did. Otherwise it was refused with 401 `device_locked`. No write ever commits under AF after the switch committed (06a §3.5, the `FOR SHARE` rule). |
| DC-12 | two concurrent merges of P_SUNITA_DUP, one into P_SUNITA and one into P_ROHAN | exactly one 201; the other 409 `PATIENT_ALREADY_MERGED` (the partial unique on `merged_patient_id`) |

---

## 17. Expiry boundaries in IST (rules 7–9, D-4)

| ID | Clock (IST) | Scenario | Expected |
|---|---|---|---|
| DE-01 | 2026-10-07 23:59:59 | dispense 5 ISO | 201; FEFO takes `ISO-T` (it expires today) |
| DE-02 | 2026-10-08 00:00:00 (= 2026-10-07T18:30:00Z) | dispense 5 ISO | 201; FEFO **skips** `ISO-T` and takes `ISO-1` |
| DE-03 | 2026-10-08 00:00:00 | a manual allocation from `ISO-T` | 409 `BATCH_EXPIRED` |
| DE-04 | 2026-10-08 00:00:00 | dispense 25 ISO | 409 `INSUFFICIENT_STOCK`, `availableBase = 20`, `expiredOnHandBase = 10` |
| DE-05 | 2026-10-07 10:00 | dispense 20 PCM | `PCM-OLD` skipped; 15 from `PCM-DEC` + 5 from `PCM-MAR` |
| DE-06 | 2026-10-08 00:00:00 | a direct SQL `DISPENSE` movement on `ISO-T` with `occurred_at` = now | trigger hint `BATCH_EXPIRED` |
| DE-07 | 2026-10-07 23:59:59 | the same | accepted |
| DE-08 | — | GRN line expiry `03/2027`; `02/2028` | stored as `2027-03-31` / `2028-02-29`; `expiry_as_printed` kept |
| DE-09 | 2026-10-07 | a GRN line with expiry 2026-09-30 | 409 `BATCH_EXPIRED` |
| DE-10 | 2026-10-07 | `EXPIRY_WRITEOFF` of `PCM-OLD` | 201 |
| DE-11 | 2026-10-07 | `EXPIRY_WRITEOFF` of `PCM-MAR` | 409 `EXPIRY_WRITEOFF_NOT_EXPIRED` |
| DE-12 | 2026-10-07 | `DAMAGE_WRITEOFF` of `PCM-OLD` (a vial broke) | **201** (corrections are allowed on expired stock, D-4) |
| DE-13 | 2026-10-07 | `STOCKTAKE_ADJUSTMENT` −2 on `PCM-OLD` (a count correction) | **201** |
| DE-14 | 2026-10-07 | a supplier return of `PCM-OLD` | 201 |
| DE-15 | 2026-10-08 00:30 | reverse yesterday's dispense of `ISO-T` | 201; `ISO-T` on hand restored; **still not dispensable** |
| DE-16 | 2026-10-08 | a patient return `RESTOCK` into `ISO-T` | 201; not dispensable afterwards |
| DE-17 | — | introspection over settings schemas, permission keys and request schemas | **no** setting, flag, permission or field can disable the expiry block |
| DE-18 | — | `istToday()` at 2026-10-07 18:29:59Z / 18:30:00Z | 2026-10-07 / 2026-10-08 |
| DE-19 | 2026-10-07 | the import commits an already-expired row for LOC_A_GJ | the opening balance lands in **LOC_A_GJ_Q**, not LOC_A_GJ (D-14) |
| DE-20 | 2026-10-07 | from LOC_A_GJ_Q: `EXPIRY_WRITEOFF` of `PCM-Q`; a supplier return; an adjustment −1; a dispense | 201; 201; **409 `QUARANTINED`**; never an allocation candidate (`INSUFFICIENT_STOCK` if nothing else) |

---

## 18. Backdating (D-4, D-10 … D-13, D-22; MR-15, MR-20)

The clock is **2026-10-08 10:00 IST** unless stated. Reason-free lag 120 min; standard window 48 h; extended window 168 h. Every row whose lag is beyond the reason-free lag sends a `stock.backdate` signing-PIN grant (D-33) unless it says otherwise; DPN-12 covers the refusal without one.

| ID | Actor | Scenario | Expected |
|---|---|---|---|
| DT-01 | AF | dispense ISO with `occurredAt` 2026-10-07 18:00 and reason `SYSTEM_UNAVAILABLE` | 201. FEFO **as of 10-07** takes `ISO-T` (valid on the actual date). The header and movements carry both times. |
| DT-02 | AF | `occurredAt` 2026-10-08 00:30, manual `ISO-T` | 409 `BATCH_EXPIRED` (checked at the actual date) |
| DT-03 | AF | `occurredAt` **90 min** ago, no reason | **201** (within the reason-free lag) |
| DT-04 | AF | `occurredAt` **3 h** ago, no reason | 422 `BACKDATE_REASON_REQUIRED` |
| DT-05 | AF | `occurredAt` 47 h ago with a reason; then 49 h ago with a reason | 201; then **403 `forbidden`** (beyond the standard tier; reception lacks `stock.backdate_extended`) |
| DT-06 | AA | `occurredAt` 6 days ago with a reason; then 8 days ago | 201; then 422 `BACKDATE_WINDOW_EXCEEDED` (the 7-day hard cap) |
| DT-07 | A1 (doctor) | `occurredAt` 49 h ago with a reason | 403 `forbidden` (doctors have the standard tier) |
| DT-08 | AF | `occurredAt` 10 min in the future | 422 `OCCURRED_AT_IN_FUTURE` |
| DT-09 | AF | **H1, within the scheduled lag:** AZI with `occurredAt` **25 min** ago, no reason | 201 |
| DT-10 | AF | **H1, beyond the scheduled lag but inside the reason-free lag:** AZI with `occurredAt` **45 min** ago, first without a reason, then **with** one | **422 `BACKDATE_NOT_ALLOWED_SCHEDULED`** both times (D-22: 30 min, and no reason or tier extends it). The same for SCX (X) and NDX (NDPS), with licences set. |
| DT-11 | AF | **As-of stock** (run with a non-scheduled copy of AZI, since DT-10 covers the H1 rule): `AZI-1` (3) is fully dispensed at 2026-10-07 12:00; a GRN posted now with `receivedAt` = now brings `AZI-2`; then a dispense of 2, backdated to 10-07 18:00 with a reason | 409 `INSUFFICIENT_STOCK_AS_OF`: stock that arrived later cannot be used |
| DT-12 | AF | **Stock used before the invoice was keyed (D-11):** a GRN posted now with `receivedAt` 2026-10-07 09:00 (invoice date 10-07, reason `STOCK_USED_BEFORE_INVOICE_KEYED`) brings 30 PCM; then a PCM dispense backdated to 10-07 15:00 with a reason | the GRN → 200, and its `RECEIPT.occurred_at` = 10-07 09:00; the dispense → 201, drawing on the new batch |
| DT-13 | AF | GRN `receivedAt` 2026-10-05, with invoice date 2026-10-06 | 422 `RECEIVED_BEFORE_INVOICE` |
| DT-14 | AF | GRN `receivedAt` 49 h ago | 403 `forbidden` (tier) |
| DT-15 | AA | **Intermediate negativity:** receive 10 at T0; dispense 10 at T2; receive 10 at T3; then backdate a dispense of 5 to T1 (T0 < T1 < T2) | service: 409. A direct SQL insert of the same movement → trigger hint `INSUFFICIENT_STOCK_AS_OF`. |
| DT-16 | AA | **Mode as of the actual date:** A_GJ switched RMP → CONSUMABLES_ONLY at 09:00 today; then a PCM dispense backdated to 10-07 18:00. Then the reverse switch and case. | 201 with `modeSnapshot = RMP_OWN_PATIENTS`; the reverse case → 409 `MODE_FORBIDS_OPERATION` |
| DT-17 | AA | **NDPS at the actual date:** A_GJ's NDPS licence is valid till 2026-10-07. An NDX dispense backdated to 10-07 17:00 with a reason. Then one with `occurredAt` 10-08 00:05, recorded at 00:20 (inside the 30 min). | 422 `BACKDATE_NOT_ALLOWED_SCHEDULED`; then 422 `LICENCE_REQUIRED_NDPS` (the licence had lapsed on the actual date) |
| DT-18 | AA | the H1 register after DT-09 and a non-backdated AZI dispense | **every** row shows the supply time and the recorded time (D-10), equal or not |
| DT-19 | AA | **The reversal window runs from `recorded_at`:** a dispense backdated 30 h, reversed 2 h after it was recorded (window 24 h) | 201 |
| DT-20 | AA | the reason-free lag set to 30 min (data, no deploy); then a dispense 45 min late with no reason; then with a reason | 422 `BACKDATE_REASON_REQUIRED`; then 201, with `reason_after_minutes_snapshot = 30` stored |
| DT-21 | — | a write-off, adjustment, supplier return or reversal body carrying `occurredAt` | 422 (unknown field: these are never backdated) |
| DT-22 | — | direct SQL: a movement with an 8-day lag; a header whose lag exceeds its snapshot, with no reason | CHECK violation (both) |
| DT-23 | AA | `scheduled_entry_max_minutes` set to 15 (data, no deploy); then an AZI dispense recorded 20 min after supply | 422 `BACKDATE_NOT_ALLOWED_SCHEDULED`; an accepted scheduled dispense stores `scheduled_entry_max_minutes_snapshot` |

---

## 19. Units and MRP (rules 5–6)

| ID | Scenario | Expected |
|---|---|---|
| DU-01 | PCM `quantity: 1`, unit strip | `qtyBase = 15` |
| DU-02 | `quantity: "0.5"`, unit box (150) | `qtyBase = 75` |
| DU-03 | `quantity: "0.5"`, unit tablet | 422 `QTY_NOT_WHOLE_BASE_UNITS` |
| DU-04 | `quantity: 1.5` as a JSON **number** | 422 `QTY_FORMAT` |
| DU-05 | `quantity: "1.2345"` | 422 `QTY_FORMAT` |
| DU-06 | a unit that is not `dispensable` | 422 `UNIT_NOT_DISPENSABLE` |
| DU-07 | 7 tablets at `unitPricePaise = 300` (MRP 4500 / 15) | 201 |
| DU-08 | 7 tablets at 301 | 422 `PRICE_ABOVE_MRP`, `maxUnitPricePaise = 300` |
| DU-09 | 1 strip at 4500 | 201 |
| DU-10 | a line split across batches with MRPs of 4500 and 4800 per strip, priced 4700 | 422 (the 4500 batch binds) |
| DU-11 | an MRP of 10000 per strip of 15 | the displayed per-tablet MRP is 666 (floor); 666 passes; 667 fails |
| DU-12 | `quantity: "1.5"` strips at 4500 | `grossPaise = 6750` |
| DU-13 | a discount above gross | 422 `DISCOUNT_EXCEEDS_GROSS` |
| DU-14 | `unitPricePaise` omitted | 201; the price is NULL; the allocation MRP snapshots are still recorded |
| DU-15 | `unitPricePaise: 4500.5` or `"4500"` | 422 (money must be an integer JSON number) |
| DU-16 | a GRN of 2 boxes + 1 free box of PCM | one `RECEIPT` of 450 base units |
| DU-17 | a GST row for the HSN at 1200 bp from 2026-04-01; then an overlapping range | `gstRateBp = 1200` snapshotted; 422 `TAX_RATE_OVERLAP` |

---

## 20. Idempotency (rule 11)

| ID | Scenario | Expected |
|---|---|---|
| DK-01 | E-28 with no `Idempotency-Key` | 400 `IDEMPOTENCY_KEY_REQUIRED`; no writes |
| DK-02 | the same request replayed with the same key | the same status and `id`; header `Idempotent-Replayed: true`; **the movement count is unchanged** |
| DK-03 | the same key with a different body | 422 `IDEMPOTENCY_KEY_REUSED`; no writes |
| DK-04 | the same key fired concurrently twice | exactly one dispense; the other request replays |
| DK-05 | the first attempt gets 409 `INSUFFICIENT_STOCK`; stock is received; a retry with the same key | 201 (failures are not remembered) |
| DK-06 | org B uses A's key value | independent |
| DK-07 | route introspection | every write route requires the header, except the documented exemptions (06a §12.2) |
| DK-08 | replays of a GRN post, a reversal and an import commit | no second `RECEIPT`, `REVERSAL` or `OPENING_BALANCE` |
| DK-09 | the `idempotency_keys` schema | no response-body column |
| DK-10 | replays of P-02 (patient), P-07 (prescription) and P-10 (image) with the same key | one patient, one prescription, one image |
| DK-11 | A-02 sign-in and A-11 switch | need no key and are never replayed: two identical sign-ins create two sessions (the second replaces the first on a trusted device) |

---

## 21. Dispensing-mode matrix (per premises; every rule passes and fails)

| ID | Rule | Pass | Fail |
|---|---|---|---|
| DM-01 | MR-01 patient required (RMP) | A_GJ: a dispense for P_SUNITA → 201 | A_GJ: no `patientId` → 422 `PATIENT_REQUIRED`; `saleType: WALK_IN` → 409; SUN (retail) with no patient → 422 `PATIENT_REQUIRED` |
| DM-02 | MR-01 patient of the organisation | P_SUNITA → 201 | P_AYESHA → 404, identical to `NONEXIST`; an archived patient → 422 `PATIENT_ARCHIVED` |
| DM-03 | MR-02 prescriber | DOC_A1 → 201 | DOC_A2 (no `registration_no`) → 422 `PRESCRIBER_REGISTRATION_MISSING`; DOC_EXT at A_GJ → 422 `PRESCRIBER_NOT_INTERNAL`; an inactive prescriber → 404 `PRESCRIBER_NOT_FOUND`; missing → 422 |
| DM-04 | MR-03 supplier licence at an RMP premises | a GRN at A_GJ from SUP_LIC posts | from SUP_NOLIC at A_GJ → 422 `SUPPLIER_LICENCE_MISSING`; nothing posted |
| DM-05 | MR-03 an expired licence only warns | SUP_LIC `valid_till` 2026-01-01 → 200 + warning `SUPPLIER_LICENCE_EXPIRED` | — |
| DM-06 | MR-04 manufacturer details | a master with an address → posts | a custom MEDICINE item with no address anywhere → 422 `MANUFACTURER_DETAILS_MISSING` |
| DM-07 | MR-05 purchase register per premises | after DM-04's pass, the E-40 purchase register for A_GJ has the line with every Schedule K field; A_MH's does not | — |
| DM-08 | MR-06 **per premises** | the same user, same organisation, same patient: a dispense at **A_GJ** → 201 | a dispense / preview / patient return at **A_MH** → 409 `MODE_FORBIDS_OPERATION` |
| DM-09 | MR-07 CONSUMABLES_ONLY operations | at A_MH: a GRN from **SUP_NOLIC** posts; a GLV procedure use, write-off, adjustment and reversal → 2xx | — |
| DM-10 | MR-08 the NDPS licence is **per premises** | NDPS licence recorded at A_MH only: an NDX GRN at A_MH posts | an NDX GRN or dispense at **A_GJ** → 422 `LICENCE_REQUIRED_NDPS` |
| DM-11 | MR-08 an expired licence | — | A_MH licence `valid_till` 2026-10-06 → 422 |
| DM-12 | MR-09 Schedule X | with A_GJ's X licence, SCX posts, and dispenses at A_GJ from a prescription line matched to SCX | without the licence → 422 `LICENCE_REQUIRED_SCHEDULE_X` |
| DM-13 | MR-10 disposal | the licence removed after NDX was received → a write-off and a supplier return → 201 | — |
| DM-14 | MR-11 the expired hard block | DE-01 | DE-03, DE-04; DE-17 proves no override exists |
| DM-15 | MR-13 | — | E-05 / E-06 with `LICENSED_PHARMACY` → 422 `MODE_NOT_AVAILABLE` |
| DM-16 | MR-14 / DB CHECK | — | direct SQL: a dispense with `mode_snapshot = 'CONSUMABLES_ONLY'`; an RMP dispense with NULL `patient_id`; an RMP dispense with `prescriber_kind_snapshot = 'EXTERNAL'` → CHECK violation each |
| DM-17 | a mode change is not retroactive | A_GJ dispenses, then switches to `CONSUMABLES_ONLY`: the old dispense keeps `RMP_OWN_PATIENTS` and stays in the H1 register; A_MH is unaffected | a new dispense at A_GJ → 409 |
| DM-18 | the procedure-use patient link | a TOX use at A_GJ with a patient → 201; a GLV use with no patient → 201 | a TOX use with no patient → 422 `PATIENT_REQUIRED` |
| DM-19 | no default mode; configured premises only | E-05 with a mode → 201 | E-05 `{}` → 422; any stock write at an unconfigured premises → 409 `PREMISES_NOT_CONFIGURED` |
| DM-20 | **one patient across premises** | P_SUNITA dispensed at A_GJ, then a procedure use at A_MH | the same `patientId` on both; E-29 `?patientId=P_SUNITA` lists both, each with its `premisesId` |
| DM-21 | MR-15 backdating | DT-01, DT-03, DT-12 | DT-04, DT-05, DT-08, DT-13 |
| DM-22 | MR-17 containers (P1-C) | DV-02 | DV-04 |
| DM-23 | **MR-18:** a prescription is required for Schedule X and `requires_prescription` items (D-23) | ISO 10 from RX_S1 L_ISO → 201; ACI 10 from L_ACI → 201; ISO 5 from RX_S1_PHOTO L_ISO2 (photo evidence, unverified) → 201 | • ISO with no `prescriptionLineId` → 422 `RX_REQUIRED`.<br>• ISO linked to L_PCM → 422 `RX_LINE_ITEM_MISMATCH`.<br>• From RX_S1_BARE → 422 `RX_EVIDENCE_REQUIRED`.<br>• From RX_S1_NOQTY → 422 `RX_QTY_NOT_RECORDED`.<br>• ACI 15 then ACI 10 against L_ACI (20) → 201, then 409 `RX_QTY_EXCEEDED` `{prescribedBase: 20, alreadyDispensedBase: 15}`. A patient return of 5 does not change that; reversing the first dispense does (the 10 then → 201).<br>• From RX_S1_VOID → 409 `PRESCRIPTION_VOID`.<br>• L_ISO8 of RX_R1 (Rahul's) for Sunita → 422 `PRESCRIPTION_PATIENT_MISMATCH`.<br>• SCX with no prescription → 422 `RX_REQUIRED`.<br>No request field or premises setting can clear a flag the master or Schedule X imposes (DG-09, DG-10). |
| DM-24 | **MR-19** premises membership | DI-01 | DI-14, DI-17 |
| DM-25 | **MR-20** H1/X/NDPS recorded within the scheduled lag | DT-09 | DT-10, DT-17, DT-23 |
| DM-26 | **MR-21** prescription integrity | a PCM dispense from RX_S1 L_PCM → 201 | • `prescriptionId = RX_A2` with `prescriberId = DOC_A1` → 422 `PRESCRIPTION_PRESCRIBER_MISMATCH`.<br>• RX_S1 on a dispense AF backdates to 2026-10-05 18:00 (with a reason) → 422 `PRESCRIPTION_DATED_AFTER_SUPPLY`.<br>• `prescription_max_age_days = 1` at A_GJ, then on 2026-10-08 a dispense from RX_S1 (prescribed 10-06) → 422 `PRESCRIPTION_TOO_OLD`.<br>• RX_S1_EMPTY (a PHOTO record with no image) → 422 `PRESCRIPTION_IMAGE_MISSING`. |
| DM-27 | **MR-22** H1 register fields | AZI for P_SUNITA at A_GJ → 201 | AZI for P_RAHUL (no address) at A_GJ → 422 `PATIENT_DETAILS_REQUIRED` `{fields: ["address"]}`; after P-03 adds the address → 201 |

---

## 22. Operation behaviour (DO)

| ID | Scenario | Expected |
|---|---|---|
| DO-01 | GRN draft → post | a `RECEIPT` per line; batches created or resolved; the supplier snapshot written; `POSTED` |
| DO-02 | a GRN for an existing batch (same number and expiry) | the batch is reused; `on_hand` increases at that location |
| DO-03 | the same batch with a different MRP | 409 `BATCH_MRP_MISMATCH` |
| DO-04 | a second GRN with the same supplier and invoice number | 409 `DUPLICATE_INVOICE`; allowed after the first is reversed |
| DO-05 | a dispense with H1 AZI from RX_S1 | The register snapshot is filled:<br>• prescriber name, `G-12345`, "Gujarat Medical Council";<br>• **A_GJ's address** (DOC_A1 has none of its own);<br>• the patient's name and address (A_GJ's extra);<br>• the prescription serial "SE/1042".<br>A PCM-only dispense leaves the snapshot NULL. |
| DO-06 | a substitution with a reason | `substituted_for_item_id`, the reason and `substituted_by = actor` recorded; a partial triple → 422 `SUBSTITUTION_INCOMPLETE` |
| DO-07 | *(withdrawn: appointments are not part of this app)* | |
| DO-08 | a patient return `RESTOCK` | `PATIENT_RETURN` +q to the original batch; the returnable qty decreases |
| DO-09 | a patient return `DISCARD` | `PATIENT_RETURN` +q and `DAMAGE_WRITEOFF` −q (`RETURN_NOT_RESALEABLE`); net 0 |
| DO-10 | `DISCARD` after the batch has expired | `PATIENT_RETURN` +q and `EXPIRY_WRITEOFF` −q |
| DO-11 | returning more than dispensed minus prior returns | 422 `RETURN_EXCEEDS_DISPENSED` |
| DO-12 | reverse a dispense within 24 h of `recorded_at` (with a grant) | a `REVERSAL` per movement; `REVERSED`; the H1 register shows it marked |
| DO-13 | the same at 24 h + 1 s | 409 `REVERSAL_WINDOW_CLOSED` |
| DO-14 | reverse a dispense that has a return | 409 `DOCUMENT_HAS_DEPENDENTS` |
| DO-15 | reverse a GRN whose stock was partly dispensed | 409 `INSUFFICIENT_STOCK`; nothing changed |
| DO-16 | reverse twice | 409 `ALREADY_REVERSED` |
| DO-17 | an opening-balance adjustment on a key that already has movements | 409 `OPENING_BALANCE_NOT_ALLOWED` |
| DO-18 | **low stock per premises:** PCM reorder level 20; LOC_A_MH holds 22; a procedure use of 3 PCM at A_MH | Exactly one `stock.low`, with `premisesId = A_MH`; none for A_GJ (45 dispensable there). Another use of 1 at A_MH → no second event. The expired `PCM-OLD` never counts. |
| DO-19 | preview | the same allocations the following dispense makes; writes nothing (row counts unchanged) |
| DO-20 | a manual pick of a later-expiring batch | 201 with warning `NOT_FEFO`; `selection = MANUAL` |
| DO-21 | a sweep over the DP generator's output | every movement has an actor, `occurred_at`, `recorded_at`, a reference that resolves to a same-tenant document, and a reason where required |
| DO-22 | a location that is not in the given premises (`premisesId = A_GJ`, `locationId = LOC_A_MH`) | 422 `LOCATION_NOT_IN_PREMISES`; a direct SQL insert hits the composite-FK violation |
| DO-23 | E-28a for RX_S1 | lists L_AZI, L_ISO, L_ACI and L_PCM with the medicine and quantity as written, and the remaining prescribed quantity for L_ISO and L_ACI. PCM is **offered and pre-selected** for L_PCM, but nothing is dispensed until confirmed. |
| DO-24 | a dispense from L_PCM with SUN chosen and no substitution triple; then with one | 422 `SUBSTITUTION_INCOMPLETE`; 201 with `substituted_by` = AF |
| DO-25 | a dispense linked to RX_S1 | `prescription_id` and the per-line `prescription_line_id` stored; the H1 register row carries "SE/1042" |
| DO-26 | `prescriptionId = RX_S1` with `prescriberId = DOC_A2` | 422 `PRESCRIPTION_PRESCRIBER_MISMATCH` |
| DO-27 | the expiry report after an import of expired stock | the quarantined batch is listed under "quarantined, awaiting write-off or return" |
| DO-28 | **premises-scoped batches (D-31):** at A_GJ, an E-28 with a manual allocation naming A_MH's `PCM-MAR` batch row; AA receives a return at A_MH for a dispense made at A_GJ | 404 `BATCH_NOT_FOUND`; 409 `RETURN_WRONG_PREMISES` |

---

## 23. Opened containers (P1-C; in the gate if 06 OQ-1 confirms)

TOX: base `UNIT`, vial = 100, `in_use_hours` = 24 (test data). The clock is 2026-10-07 10:00 IST unless stated.

| ID | Scenario | Expected |
|---|---|---|
| DV-01 | a procedure use of 20 U for P_SUNITA, no container open | opens container C1 from `TOX-1` (FEFO), with `discard_after` = 2026-10-08 10:00 IST; draws 20; C1 remaining 80; ledger `PROCEDURE_USE` −20 on `TOX-1` |
| DV-02 | a second use of 30 U | draws from C1 (remaining 50); no new container |
| DV-03 | a use of 90 U with C1 at 50 | 50 from C1 (→ `EXHAUSTED`), plus C2 opened from `TOX-1` with 40 drawn; two allocations |
| DV-04 | Clock 2027-01-10 10:00: open C3 from `TOX-2` (the last vial) and draw 10. Clock 2027-01-11 10:00:01: draw 5. Then an explicit draw from C3. | The draw fails with 409 `INSUFFICIENT_STOCK` (`lapsedContainerUnits = 90`; no sealed stock is left). The explicit draw fails with 409 `CONTAINER_LAPSED`. |
| DV-05 | discard C3 | `DAMAGE_WRITEOFF` 90 with reason `OPENED_CONTAINER_LAPSED`; `DISCARDED`; `TOX-2` on hand 0 |
| DV-06 | an early discard of an open container with reason `DAMAGED`; with `OTHER` and no note | 201; 422 `NOTE_REQUIRED` |
| DV-07 | clock 2026-10-08 00:30, no container open, use 10 U | `TOX-1` has expired, so a container opens from `TOX-2` |
| DV-08 | C2 (from `TOX-1`, opened 2026-10-07 20:00, not lapsed) at 2026-10-08 00:30 | a draw from C2 → 409 `BATCH_EXPIRED` (expiry overrides an open container) |
| DV-09 | two concurrent draws of 60 U from a container with 100 remaining and no sealed stock | one 201, one 409; Σ draws ≤ 100 |
| DV-10 | a direct SQL allocation against a `DISCARDED` container | the trigger raises |
| DV-11 | dispensing TOX to a patient in unit `UNIT`; then 1 vial, with sealed stock ≥ 100 | 422 `UNIT_NOT_DISPENSABLE`; 201 |
| DV-12 | **reversal after discard (D-20):** reverse a procedure use whose container is now `DISCARDED` | In one transaction: `REVERSAL` +q **and** a paired `DAMAGE_WRITEOFF` −q, linked to the container. Net stock change 0. The container's remaining stays 0, status `DISCARDED`. |
| DV-12a | reverse a procedure use whose container is still `OPEN` | the units return to the container (remaining increases); no wastage row |
| DV-13 | the daily job at 2026-10-08 10:05 with C2 still `OPEN` | one `container.lapsed` event; the stock overview shows "discard pending: N U" |
| DV-14 | a procedure use backdated to before C1 was opened | C1 is not eligible (it opened after `occurred_at`); a container opens at `occurred_at` from sealed stock |
| DV-15 | policy `BLOCK` (the default); A1 sends `lapseOverride` on a lapsed container, with a grant | 409 `CONTAINER_LAPSED`: no override exists under `BLOCK` |
| DV-16 | policy `DOCTOR_OVERRIDE`; A1 sends `lapseOverride {containerId, reason}` with a `container.lapse_override` grant | 201; the allocation records the reason and the actor; one row in the lapsed-use report (DR-14) |
| DV-17 | policy `DOCTOR_OVERRIDE`; AF (no prescriber link) sends `lapseOverride` | 403 `prescriber_login_required` |
| DV-18 | policy `DOCTOR_OVERRIDE`; A1 without a reason | 422 `OVERRIDE_REASON_REQUIRED` |
| DV-19 | policy `DOCTOR_OVERRIDE`; a request without `lapseOverride` | a lapsed container is never chosen automatically |
| DV-20 | policy `DOCTOR_OVERRIDE`; A1 with a reason but no grant | 401 `reauth_required` |

---

## 24. Registers and reports (DR)

| ID | Scenario | Expected |
|---|---|---|
| DR-01 | the H1 register for A_GJ, October, after DO-05 | One row per H1 allocation, with:<br>• **supply date and time** and **recorded date and time**, both on every row (D-10);<br>• Dr. Meera Kulkarni, G-12345 · Gujarat Medical Council, A_GJ's address;<br>• Sunita Patil and her address (A_GJ's extra);<br>• AZI's name and strength; qty; `AZI-1`;<br>• "SE/1042". |
| DR-02 | the H1 register for A_MH | contains none of A_GJ's dispenses |
| DR-03 | the patient's name, or the prescriber's address, is edited after the dispense | the register still shows the snapshot |
| DR-04 | the IST boundary: a dispense at 2026-10-31 23:30 IST, and one at 2026-11-01 00:10 IST | the first is in October; the second is not |
| DR-05 | the purchase register for A_GJ | every posted line at A_GJ, with **received at** and **recorded at**, the supplier licence snapshot, the manufacturer's name and address, batch, expiry, qty and free qty; reversed GRNs are marked, never removed |
| DR-06 | the expiry report at A_GJ, 2026-10-07 10:00, windows {30, 60, 90} | • **Expired:** `PCM-OLD`.<br>• **Quarantined:** `PCM-Q`.<br>• **≤ 30 d:** `ISO-T`, `TOX-1` (they expire today; not yet expired).<br>• **≤ 90 d:** `PCM-DEC` (85 d).<br>• **Not listed:** `ISO-1` (116 d), `PCM-MAR`, `AZI-1`, `ACI-1`, `SUN-1`, `TOX-2`. |
| DR-07 | the low-stock report | per premises; suggestion `max(reorder_qty, level − dispensable on-hand)` |
| DR-08 | consumption by prescriber and by procedure type | net of reversals and returns |
| DR-09 | valuation at cost and at MRP, `as_of` = yesterday | equals a hand-computed fixture value; uses only movements up to the end of that IST day |
| DR-10 | a CSV export of the H1 register: without a grant; with a `register.export` grant | 401 `reauth_required`. Then: UTF-8 with a BOM; `DD-MM-YYYY HH:mm` IST; **one `audit_log` row** `register.exported` with `{register, format, count, from, to}`, in the same transaction; the audit sanitizer refuses any patient content in `detail`. |
| DR-11 | E-40 without `premisesId`, or for a period > 366 days | 422 |
| DR-12 | every report after the cache is truncated and rebuilt | identical output |
| DR-13 | E-39 stock overview with no `premisesId` (the owner's combined view) | totals equal A_GJ + A_MH; each premises is also reported separately |
| DR-14 | the lapsed-use report under `DOCTOR_OVERRIDE`, after DV-16 | one row: prescriber, item, batch, container, units, minutes past `discard_after`, reason; no patient name |
| DR-15 | the entry-lag report after the DT suite | the lag distribution by role and document type; the share beyond the reason-free lag; no patient fields |
| DR-16 | the H1 register print view | The HTML has a header block that repeats on every printed page (premises name, address, state, licences, period). Patient names are text, never images: a fixture name in Gujarati script appears as Unicode text. A person checks a printed sample before go-live (§30). |

---

## 25. Events and jobs (DJ)

| ID | Scenario | Expected |
|---|---|---|
| DJ-01 | the daily job at 2026-10-08 00:10 IST | `batch.expired` for `ISO-T` and `TOX-1`; `batch.near_expiry` for each window entered; payloads hold ids and integers only |
| DJ-02 | an item whose only above-threshold stock at a premises expires overnight, with no movement | exactly one `stock.low` (expiry-driven) |
| DJ-03 | the job run twice on the same IST date | no duplicate events |
| DJ-04 | the job skipped for 3 days, then run | catches up; no duplicates |
| DJ-05 | reconciliation with no drift | `drift_count = 0` |
| DJ-06 | the migrator corrupts one `on_hand` (test only), then reconciliation runs | `drift_count = 1`; `ledger.drift_detected`; the cache is **not** auto-corrected; `rebuild_balances` fixes it |
| DJ-07 | the job's role | `pharmacy_jobs`: not a superuser, no `BYPASSRLS`; it lists organisations through `org_directory` and processes each inside `withTenant` |
| DJ-08 | a scan of every outbox payload the DP generator produced | no patient name, phone number or item name |
| DJ-09 | static check | Stock and prescription code imports no HTTP client. Only `lib/auth/otp/*` may call the WhatsApp or SMS provider, and it sends only OTP templates. |
| DJ-10 | `container.lapsed` under the `DOCTOR_OVERRIDE` policy | still emitted for a lapsed `OPEN` container: the override never silences the prompt |
| DJ-11 | the purges | idempotency keys > 7 days, OTP challenges > 1 day, and sessions ended > 90 days are deleted; audit rows that name those sessions remain |
| DJ-12 | the weekly job, with `prescription_images` totalling 8.1 GB (a test that fakes the `byte_size` sum), and with v1 PIN hashes left after a v2 rotation | one image-size alert (80 % of the 10 GB threshold, D-35) and one pepper-version alert; the output holds counts and sizes only |
| DJ-13 | the curator raised a master's `requires_prescription` yesterday | the daily job sets it on every linked item, organisation by organisation inside `withTenant`; one `item.requires_prescription_raised {count}` audit row per organisation; a re-run changes nothing |

---

## 26. Import (DIM)

| ID | Scenario | Expected |
|---|---|---|
| DIM-01 | upload the 6-row template CSV to LOC_A_GJ | 201; rows parsed; no movements; `UPLOADED` |
| DIM-02 | the dry-run report | per-row status and issue codes; exact matches `SUGGESTED`; the rest `UNMATCHED` |
| DIM-03 | commit with an undecided `UNMATCHED` row | 409 `IMPORT_HAS_ERRORS` |
| DIM-04 | confirm, mark one row `CUSTOM`, commit (with a grant) | items, units, batches and `OPENING_BALANCE` movements in one transaction; `COMMITTED` |
| DIM-05 | an expired-batch row | a warning; committed **into the premises' quarantine location** (DE-19); listed as quarantined in the expiry report |
| DIM-06 | `₹1,234.50`; `12.345` | `123450` paise; `BAD_MONEY` |
| DIM-07 | an XLSX numeric cell `12.3` | `1230` paise |
| DIM-08 | a quantity of 7.5 strips of 15 | `QTY_NOT_WHOLE_BASE_UNITS` |
| DIM-09 | a file with an extra `patient_name` column | dropped; `raw` has no such key |
| DIM-10 | commit the same file twice | the second → 409 |
| DIM-11 | the commit fails at row 4 (fault injection) | nothing committed |
| DIM-12 | reverse a committed import with no later movements | a `REVERSAL` for every opening balance; `REVERSED` |
| DIM-13 | reverse after one of its batches was dispensed | 409 `DOCUMENT_HAS_DEPENDENTS` |
| DIM-14 | an NDX row for LOC_A_GJ (no NDPS licence there) | a `LICENCE_REQUIRED_NDPS` row error |
| DIM-15 | matching determinism | the same file gives the same candidates; no network call in the import path |

---

## 27. Migrations (DMG)

| ID | Scenario | Expected |
|---|---|---|
| DMG-01 | apply every migration to an empty DB with the runner, as the **migrator** | reaches head |
| DMG-02 | run the runner again at head | a no-op |
| DMG-03 | apply each NNN to a DB at NNN−1 holding the previous step's seeded data | succeeds; existing rows intact |
| DMG-04 | a deliberately broken migration | the runner exits **non-zero** and the deploy fails |
| DMG-05 | introspection: every table with `org_id` | `NOT NULL`, **no default**, FK to `organisations` `RESTRICT`, **`PRIMARY KEY (org_id, id)`**; branch-level tables also carry `(org_id, premises_id)` → `premises` |
| DMG-06 | introspection: every FK between tenant tables | composite on `org_id` |
| DMG-07 | introspection: the app role's grants | No UPDATE/DELETE on `stock_movements`, `audit_log` or any history table. No TRUNCATE anywhere. SELECT only on `medicine_master`. DELETE only on `idempotency_keys`, `otp_challenges` and draft lines. No INSERT on `organisations`. |
| DMG-08 | a static check over the migration files (R6-8) | an `ALTER TABLE` on a table an earlier migration created only adds (a column, index, constraint or FK); no `DROP`, `RENAME` or type change of an existing object |
| DMG-09 | the `stock_balances` unique, and the server version | `NULLS NOT DISTINCT`; server version ≥ 15 asserted |
| DMG-10 | **Backup restore drill,** before the first organisation's real data goes in (D-21): restore the latest production backup into a scratch Postgres; run the self-check and the reconciliation job against it | succeeds; the restore time is recorded in the PR. **This restore is the rollback plan; there are no down migrations.** |
| DMG-11 | **Previous-version compatibility,** from the second release onward: the previous build run against the migrated schema (the e2e smoke) | green: expand/contract kept the old app working |
| DMG-12 | file names | numbered contiguously from 001; stems unique |
| DMG-13 | an already-applied file is edited; a build whose file set differs from the database's | the runner refuses (checksum mismatch) and the deploy fails; the self-check returns 503 `SCHEMA_UNVERIFIED` |
| DMG-14 | the reviewed exception list (06a §2.6 rule 5) | The test holds the list. A new single-column key, a unique without `org_id`, or an FK to a non-tenant table that is not on the list fails the build. |

---

## 28. Hygiene guards (DH)

| ID | Scenario | Expected |
|---|---|---|
| DH-01 | `captureLogs()` over a full flow: setup, GRN, recording RX_S1 with an image, a dispense to Sunita Patil, a return, an H1 export, and a 422 on a dispense | No line contains "Sunita", "Patil", "98000", any item display name, any prescription medicine text, or a patient-id-with-item-id pair. Validation errors log `{field, code}` only. |
| DH-02 | import graph | the app imports no LLM, OCR or vision client anywhere |
| DH-03 | lint | no comparison of `org_id` against a literal anywhere |
| DH-04 | lint | no `parseFloat`; no `Number(` on `*Paise`, quantity or `NUMERIC` fields; no `/ 100` on money |
| DH-05 | `int8` parsing | a `seq` above 2^31 parses to a number; a synthetic `int8` above 2^53 **throws** |
| DH-06 | `NUMERIC` handling | `qty_entered` round-trips `"1.500"` exactly; no float at any step (a property test over random 3-decimal strings) |
| DH-07 | error shape | every 4xx/5xx body has `error` (a string) and `code` |
| DH-08 | no dose computation, interaction check or auto-substitution; `days_supply`, `in_use_hours` and `qty_base_prescribed` are never computed | a code-review checklist + DO-06 + DRX-13 |
| DH-09 | *(withdrawn: this app has no AI-extracted medication tables; DRX-15 covers prescription images)* | |
| DH-10 | the actor | `actor_staff_id`/`actor_label` always come from the session's active person (DW-04); no request field names an actor |
| DH-11 | **the money helper (D-15):** walk every API response the whole suite produced | every key ending `Paise`/`_paise` is `typeof === "number"` and a safe integer; any string fails the run |
| DH-12 | lint | no `.query(` outside `lib/db/` |
| DH-13 | static check | no drug or salt name literal in the code: the MR-18 gate reads only `schedule_flags` and `requires_prescription` (D-23) |
| DH-14 | the test run | a network guard fails any outbound connection other than the test database |
| DH-15 | the production build | contains no test-only identity seam (no symbol matching `__testOnly`) |
| DH-16 | secrets | `SESSION_SECRET`, `PIN_PEPPERS`, the OTP HMAC key and the provider tokens are read from the environment only and never logged (`captureLogs()` + a scan) |

---

## 29. Phase 2 rows recorded now (not in the Phase 1 gate)

| ID | Scenario | Expected |
|---|---|---|
| DTR-01 | a transfer from A_GJ (state 24) to A_MH (state 27) | 409 `INTERSTATE_TRANSFER_BLOCKED`; a direct SQL insert of the transfer line → the trigger raises; no setting allows it |
| DTR-02 | a transfer within A_GJ (store → `QUARANTINE`) of the expired `PCM-OLD` | 201 |
| DTR-03 | transferring stock held in an open container | 422 |
| DTR-04 | a same-state transfer with `intra_state_transfers_enabled = false` | 409 `TRANSFER_NOT_ENABLED` |
| DTR-05 | the setting on; two Gujarat premises with **different GSTINs** or **different modes** | 409 `TRANSFER_GSTIN_OR_MODE_MISMATCH` |
| DTR-06 | the setting on; the same GSTIN and the same mode | 201, with a transfer document; `TRANSFER_OUT` and `TRANSFER_IN` in one transaction |

---

## 30. Definition of done

### Milestone 1 (D-38)

**The gate is every row below, green on the harness, each observed red before its PR's implementation:**
- **DS, DMG, DH:** all rows, except DS-12 and DMG-10 (pilot go-live) and DS-16 (until the master exists: PR 5).
- **DX:** every row for a Milestone 1 endpoint, plus DX-73 … 77. DX-76 fails the build if a route has no row.
- **DI, DN, DW, DAU, DG:** all rows, except DG-04 (master corrections).
- **DPN:** all rows except DPN-12 (backdating).
- **DRX-01 … 16.**
- **DL, DP, DA, DC, DE, DU, DK, DO, DM, DR, DIM:** all rows, except those that need a Milestone 2 feature:

| Moves to Milestone 2 | Rows |
|---|---|
| backdating | DT (all), DP-11, DC-08, DC-09, DM-21, DR-15 |
| procedure use, `CONSUMABLES_ONLY`, containers | DM-06 … 09, DM-18, DM-22, DO-18 (re-run at A_GJ by dispensing), DV (all), DL-26, DP-09, DJ-10, DR-14 |
| manual opening-balance adjustments, supplier returns (stock-count corrections are Milestone 1, D-42) | DE-14, DO-17, DM-13 (the supplier-return part), DE-20 (the supplier-return part) |
| the patient merge tool | DRX-17 … 23, DC-12, DX-78 … 80 |
| jobs, outbox, reconciliation, purges | DJ (all) |
| tax rates; valuation and consumption reports; XLSX | DU-17, DR-08, DR-09, DIM-07 |
| phone OTP | DQ (all), DX-03 |

**Plus:**
1. DC-01 and DC-11 pass 20× without a flake.
2. An end-to-end "day at one premises" test passes: sign in, switch, receive, dispense (with an isotretinoin prescription), return, write off, reverse, print both registers.

### Pilot go-live (after Milestone 1)

1. Hosting in its own Railway project; **DS-12** checked there.
2. **DMG-10:** the restore drill done.
3. `PIN_PEPPERS` set as a Railway variable; the rotation rehearsed once on staging (06a §3.12).
4. **A signed DPA** with the organisation (06 OQ-24).
5. Counsel's review of the registers and rules (06 OQ-8, OQ-32), including a printed H1 sample with a Gujarati name.
6. 06 OQ-1 answered.

### Milestones 2 and 3

Each gates on its own rows from the table above and on the rows of the features it adds (06 §5). The OTP channels must be live before Milestone 2's phone sign-in ships.
