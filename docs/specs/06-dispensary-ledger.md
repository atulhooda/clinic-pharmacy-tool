# Spec 06 — Clinic Pharmacy Tool: Index, Decisions, Open Questions

**Status:** **Rev 6 (standalone)**, 2026-10-08, on branch `docs/spec-06-rev4-standalone` of `clinic-pharmacy-tool`. **Milestone 1 is being built** (§5).
**Written against:** clinic-pharmacy-tool `origin/main` @ `6f5ffb2` (fetched 2026-10-08; README only, no code). Stack conventions from Ritu Desk `origin/main` @ `8bee594` (fetched 2026-10-08; no newer commits).
**History:** Revisions 4–6 were squashed into one commit when this repo's history was cleaned on 2026-10-08; the revision notes say what each changed. Earlier drafts, from when this was planned as a Ritu Desk module, are kept privately.

**Building.** Rev 6 defines **Milestone 1** (round 6). It is built as small PRs on their own branches; PR 1 (the foundation) stops for review.

**Files**
- this file: decisions, what Rev 4 replaced, conflicts, open questions, phase map;
- [06a](06a-dispensary-ledger.design.md): the design;
- [06b](06b-dispensary-ledger.acceptance.md): the acceptance gate.

**In one paragraph.** A standalone, multi-tenant pharmacy and stock app for clinics. It has its own codebase, its own Postgres (one database shared by every organisation, isolated by RLS), its own staff sign-in built for a shared front-desk PC, and its own minimal patients, prescribers and prescription records. Everything decided in rounds 1–3 about the ledger, expiry, FEFO, dispensing modes, registers, backdating, scheduled drugs, opened vials and WhatsApp is kept unchanged. Nothing in it depends on Ritu Desk, its voice server or Ritu Desk's Spec 07.

---

## 1. Decision log

### Round 1 (founder, 2026-10-07)

| ID | Decision | Outcome |
|---|---|---|
| D-0 | Host | ~~Ritu Desk / voice-server Postgres; code in Ritu Desk.~~ **Superseded by D-24** (round 4). |
| D-1 | Visibility | Organisation-wide and permission-gated. "See stock" is separate from "see who received it". **A signed DPA must exist before this ships.** (06a §4.3) |
| D-2 | Roles | Three built-in roles; permissions stored as data. Rev 4: the defaults are tested in code, and overrides and custom roles are rows, audited (06a §4.1). |
| D-3 | Data-model deviations | the engineer's call (the Rev 4 calls are listed below) |
| D-4 | Expiry vs corrections; backdating | Use of expired stock is hard-blocked; corrections are allowed. Backdating is allowed within a window, with a reason, checked at the actual date. (06a §7.1, §11.4) |
| D-5 | Money | Paise everywhere; columns end in `_paise`; convert only at the edges; parse `BIGINT` deliberately (06a §5) |
| D-6 | Branches | The business is one tenant; each premises is a location inside it. Licences, registers, state fields and mode attach to the premises. Inter-state transfers are blocked. (06a §2.1, §6.4, §10) |
| D-7 | Opened vials | Phase 1 if the pilot clinic goes first and does injectables (P1-C) |
| D-8 | Isolation | Postgres RLS keyed off a tenant setting; the app role is neither owner nor superuser (06a §2) |
| D-9 | Twin check | **Not applicable in Rev 4:** there is no voice twin. The spirit (fail, don't skip) is kept in the runner: 06a §18, 06b DMG-04/13. |

### Round 2 (founder, 2026-10-07): applied in Rev 3, kept in Rev 4

| ID | Decision | Reflected in |
|---|---|---|
| D-10 | **H1, X and NDPS lines are entered at the time of supply.** Registers show the supply time **and** the recorded time on every row. | 06a §11.4, §14, MR-20, L-21; 06b DT-09/10/17/18 |
| D-11 | **A GRN's `received_at` may be backdated,** never before the invoice date, under the same window, tier and reason rules | 06a §6.7, §9.3, L-22; 06b DT-12 … 14 |
| D-12 | **The reason threshold is per-organisation data** (default 120 min), tuned from pilot data with an entry-lag report | 06a §6.4, §11.4, §14; 06b DT-03/04/20, DR-15 |
| D-13 | **Backdating is tiered:** standard window (48 h) for reception and doctors; extended (7 days) for the owner only | 06a §4.2, MR-15; 06b DT-05 … 07 |
| D-14 | **Opening balances accept expired batches, into quarantine;** only a write-off or supplier return can move them | 06a §6.4, §7.1, L-20; 06b DL-21 … 23, DE-19/20 |
| D-15 | **All money reads go through one helper,** with a test that every `_paise` field arrives as a number | 06a §5; 06b DH-05, DH-11 |
| D-16 | **Opened vials:** keep the hard block **until the doctor is asked** whether they ever inject past the label time. Then choose explicitly: block, or a doctor-only override with a reason that appears on a report. | 06a §6.4, L-23, MR-17, §14; 06b DV-15 … 20, DR-14; OQ-27 |
| D-17 | **Stock operations are restricted to the user's own premises;** the owner sees all premises | 06a §4.4, MR-19; 06b DI-14 … 17 |
| D-18 | **The DPA** is for the founders to answer | OQ-24 |
| D-19 | **Same-state transfers** are off by default. They are allowed only between premises with the same GSTIN and the same mode, with a transfer document, enabled per organisation after the clinic's CA signs off. | 06a §6.4, §6.10, L-19, MR-16; 06b DTR-04 … 06 |
| D-20 | **Reversing a procedure use after its vial was discarded** is allowed, and is auto-paired with a wastage write-off of the same quantity | 06a §6.7, §9.3; 06b DV-12, DP-03 |
| D-21 | **No down migrations.** Forward-only expand/contract; a tested backup restore is the rollback. | 06a §18; 06b DMG-10/11 |

### Round 3 (founder, 2026-10-07): kept in Rev 4

| ID | Decision | Reflected in |
|---|---|---|
| D-22 | **Scheduled drugs (H1, X, NDPS) have their own entry-lag setting,** `scheduled_entry_max_minutes`, default 30 min. No reason or tier extends it. | 06a §6.4, §11.4, L-21, MR-20; 06b DT-09/10/17/23, DL-24 |
| D-23 | **A prescription is required for Schedule X and for any item whose medicine master carries the centrally maintained `requires_prescription` flag.** Adding a drug is a data change; no drug names are in code. **Rev 4 adapts "issued prescription" to a recorded one:** a photo or a prescriber-verified manual entry, with the line matched to the item and a typed total quantity (06a MR-18). | 06a §6.3, §6.5, MR-18, L-24; 06b DM-23, DG-08, DH-13, DC-10 |
| — | **Process rule:** every spec records the commit it was written against, and Claude Code fetches and confirms it is on current `main` before writing | this repo's `CLAUDE.md`; the headers of 06/06a/06b |

### Round 4 (founder, 2026-10-07): applied in Rev 4

| ID | Decision | Reflected in |
|---|---|---|
| D-24 | **A standalone app** with its own codebase (`clinic-pharmacy-tool`) and its own database, not a Ritu Desk module. The original brief's assumption was wrong. **Supersedes D-0.** | 06a §0.10, §1 |
| D-25 | **Multi-tenant from the first migration:**<br>• organisations + premises;<br>• RLS;<br>• the app connecting as a non-superuser, non-owner role;<br>• one shared database, no per-branch databases. | 06a §2, §18; 06b DS, DMG |
| D-26 | **No Ritu Desk dependency.** Its own minimal patients (name, phone), its own prescribers (name, registration number, address, as the H1 register needs), and prescriptions as uploaded photos or manual entries. | 06a §6.2, §9.2; 06b DRX |
| D-27 | **Its own sign-in for a shared front-desk PC:**<br>• daily full sign-in;<br>• PIN switching;<br>• idle auto-lock;<br>• a signing PIN separate from the switch PIN.<br>Ideas borrowed from Spec 07; not its code or database. | 06a §3; 06b DN, DW, DPN, DQ, DAU |
| D-28 | **Ritu Desk integration is out of v1** | OQ-30; 06a §17 |
| D-29 | **Spec 07 stays Ritu Desk work on its own track;** nothing in Spec 06 depends on it | 06a §0.10, §17 |
| D-30 | **Stack: Ritu Desk's by default,** so one engineer isn't maintaining two | 06a §1.2 (three deliberate differences, each with a reason) |

### Round 5 (founder review of Rev 4, 2026-10-08): applied in Rev 5

| ID | Decision | Reflected in |
|---|---|---|
| D-31 | **Tenant integrity beyond RLS.** Postgres skips RLS for foreign-key and unique checks, so:<br>• every FK is composite, `(org_id, id)` referencing `(org_id, id)`;<br>• batches, stock movements and dispense allocations (and every other row naming stock) also carry `premises_id` in their FKs;<br>• every unique constraint includes `org_id`.<br>Tested both ways: a cross-tenant FK insert fails, and the same value in another organisation is not a unique violation. | 06a §2.6, §5, §6, L-11, L-26; 06b DS-18 … 21, DL-28 … 30, DO-28, DMG-05/14 |
| D-32 | **R4-1 as a `requires_prescription` flag on items, stored as data.** Starting values: oral isotretinoin, acitretin, Schedule X. No drug names in code. | 06a §6.3, §6.5, MR-18; 06b DG-08 … 11, DJ-13 |
| D-33 | **R4-2 widened.** The signing PIN also covers backdated entries past the reason-free lag, and stock-count adjustments. Only users whose role holds at least one PIN-gated permission get a signing PIN. | 06a §3.7, §11.4, MR-15; 06b DPN-12 … 14 |
| D-34 | **PINs are hashed with a pepper** held outside the database as an environment secret, with a documented rotation | 06a §3.12; 06b DPN-15 … 17, DH-16 |
| D-35 | **R4-7 confirmed, with limits:**<br>• compress in the browser to a few hundred KB;<br>• keep the 2 MB server cap;<br>• photos in their own table;<br>• **move to object storage at 10 GB in total**. | 06a §1.2, §6.2, §13; 06b DRX-16, DJ-12 |
| D-36 | **Patients:**<br>• the phone is not unique (one phone serves a family);<br>• match on name + phone;<br>• a merge tool that records the merge and resolves it at read time, never rewriting dispense or ledger rows. | 06a §6.2, §9.2, L-27, P-15 … 17; 06b DRX-17 … 23, DC-12, DX-78 … 80 |
| D-37 | **The repo goes to the Engageo GitHub organisation; hosting is its own Railway project,** separate from Ritu Desk. The transfer waits for the organisation's name. | 06a §1.2; OQ-31 closed |

### Round 6 (founder, 2026-10-08): applied in Rev 6

| ID | Decision | Reflected in |
|---|---|---|
| D-38 | **Build now. Milestone 1's bar: one premises runs its dispensary on it every day.** It covers:<br>• personal sign-in and the PIN switch screen;<br>• organisation and premises setup, users and roles;<br>• items, batches, receiving stock, CSV import of opening stock;<br>• patients, prescribers, prescriptions (manual entry and photo);<br>• dispensing with FEFO, the `requires_prescription` rule, returns, write-offs, reversals;<br>• stock, low-stock and near-expiry views;<br>• the H1 and purchase registers (print view and CSV). | §5; 06a §19; 06b §30 |
| D-39 | **Nothing in Milestone 1 waits on a third party's approval.** Password sign-in for now; phone codes come later, once the WhatsApp and SMS templates are approved. **Everything else in Rev 5 moves to later milestones.** | §5 |
| D-40 | **Small PRs.** PR 1 is the foundation:<br>• the scaffold on the Ritu Desk stack;<br>• a migration runner that fails the deploy on any error;<br>• migration 001 with organisations, premises, RLS and the non-superuser app role;<br>• a real-Postgres test harness;<br>• 06b's tenant-isolation and catalog checks in the test run.<br>**Every PR:** written against the spec and a fetched commit; tests for every rule it touches; the full suite green before the next PR starts. **No hosting yet:** everything runs locally. | 06a §19 |
| D-41 | **The GitHub organisation question is dropped:** push to the existing repo, `atulhooda/clinic-pharmacy-tool`. (The repo-transfer half of D-37 is withdrawn; its own Railway project still applies when hosting comes.) | — |

### Engineer's calls in Rev 4 (under D-3; veto any)

| ID | Call | Why | Where |
|---|---|---|---|
| R4-1 | **MR-18 with recorded prescriptions.** An X or `requires_prescription` line must:<br>• link a prescription line matched to that item;<br>• have evidence: a photo, or the prescriber's PIN verification;<br>• stay within the typed total quantity (a reversal gives it back; a return does not). | Without an issuing system, a typed manual entry is otherwise the weakest link: reception could type an isotretinoin prescription. The quantity cap stops repeat dispensing beyond what was written. | 06a MR-18, L-24; OQ-32, OQ-33 |
| R4-2 | **The signing PIN is asked only for consequential actions:**<br>• verify a prescription; vial override;<br>• reversal, write-off, adjustment, import commit;<br>• premises legal settings; register export;<br>• staff, roles, devices, org settings.<br>Never for ordinary dispensing. | A PIN on every sale trains people to share it; the switch PIN already names the person. | 06a §3.7 |
| R4-3 | **A session lasts until the earlier of 16 h and the next 04:00 IST** (an org setting) | "daily full sign-in" made concrete | 06a §3.4 |
| R4-4 | **No idle timeout on untrusted browsers by default** (an org setting) | a founder preference: doctors and owners are not timed out mid-day | 06a §3.4 |
| R4-5 | **Before sign-in, the organisation comes from the trusted-device cookie or the organisation's sign-in link** (`/{slug}/sign-in`). The only cross-tenant lookup is one `SECURITY DEFINER` function, owned by a NOLOGIN role. | Keeps RLS on every table, including the login lookup | 06a §2.4 |
| R4-6 | **No write straddles a person switch:** writes hold `FOR SHARE` on the device's state row | A switch can never make a write commit under the wrong person | 06a §3.5; 06b DC-11 |
| R4-7 | **Prescription photos are stored as `BYTEA` in Postgres,** ≤ 2 MiB each after downsizing in the browser | Same as the desk's uploads; no new service. Revisit at a size threshold. | 06a §6.2; OQ-34 |
| R4-8 | **Registers are an HTML print view + CSV;** a server PDF is Phase 2 | The browser shapes Indic scripts correctly; building a PDF engine isn't needed for v1 | 06a §1.2, §14 |
| R4-9 | **The UI kit starts as a copy of the desk's components,** with no package or runtime link | One look, one engineer; still no dependency | 06a §1.2 |
| R4-10 | **Roles are hybrid:** defaults tested in code; overrides and custom roles as audited rows | The same shape the founder agreed for Ritu Desk (its T-3), re-implemented here | 06a §4.1 |

After round 5: R4-1 is decided as D-32, R4-2 is widened by D-33, and R4-7 is confirmed with the D-35 limits. The other calls stand.

### Engineer's calls in Rev 6 (under D-3; veto any)

| ID | Call | Why |
|---|---|---|
| R6-1 | **The signing PIN, with its pepper, stays in Milestone 1** | Reversals and write-offs are in Milestone 1, and D-33 makes them signed actions. It needs no third party. |
| R6-2 | **Milestone 1 supports `RMP_OWN_PATIENTS` only.** `CONSUMABLES_ONLY` waits for procedure use (Milestone 2). | A consumables-only premises has nothing to do without procedure use |
| R6-3 | **No backdating in Milestone 1.** Every entry is recorded at the time (`occurred_at = recorded_at`), so the H1 30-minute rule holds trivially. Backdating, including a GRN's `received_at`, is Milestone 2. | It is not on the Milestone 1 list. The columns and CHECKs exist from the start, so nothing is retrofitted. |
| R6-4 | **Stock-count adjustments and supplier returns are Milestone 2.** In Milestone 1, only a write-off can reduce stock outside dispensing, and found stock cannot be added. | Not on the Milestone 1 list. Say so if the pilot needs count corrections from day one: they are small. |
| R6-5 | **A minimal `medicine_master` in Milestone 1,** seeded only from the reviewed data file with the `requires_prescription` starting values (oral isotretinoin, acitretin) and NLEM generics; loaded by `pharmacy_curator`. Master corrections are Milestone 2. | D-32's starting values need master rows |
| R6-6 | **The test harness runs real Postgres from the local binaries** (`initdb`/`pg_ctl`), or from `TEST_PG_SUPERUSER_URL` when one is given (CI, Docker) | Docker isn't running on the dev Mac; the tests must run there. The database is still real, with the real roles and migrations. |
| R6-7 | **Migration 001 is one "tenancy foundation" change:** helpers, `organisations`, `premises`, RLS, the resolver function, the grants. **The roles themselves** come from `ops/bootstrap-roles.sql`, run once by the platform superuser. | That is the founder's PR 1 brief. A non-superuser migrator cannot create roles, by design. |
| R6-8 | **Later milestones may `ALTER` earlier tables, but only to add:** a nullable column, an index, a constraint added `NOT VALID` then validated, an FK. Never to drop, rename or retype. 06b DMG-08 checks it. | "Never alter a table you didn't create" came from living inside Ritu Desk. Here, later milestones extend Milestone 1's tables. |
| R6-9 | **Tables are created with Rev 5's full plain-column set** (e.g. the backdate columns on dispenses). Only FKs to Milestone 2 tables (e.g. `opened_container_id`) are added later. | Fewer `ALTER`s later; the CHECKs hold from day one |

### Engineer's calls in Rev 5 (under D-3; veto any)

| ID | Call | Why | Where |
|---|---|---|---|
| R5-1 | **Primary keys are `(org_id, id)`,** not `id` plus a separate `UNIQUE (org_id, id)` | It satisfies "every unique constraint includes the organisation" literally, and the composite FKs reference the primary key | 06a §2.6 |
| R5-2 | **Batches are per premises,** and `premises_id` is added to every row that names a batch or a location, not only the three named in D-31 | Otherwise a GRN, adjustment or return line could still name another branch's batch. Side effect: a patient return must be received at the premises that dispensed (a branch in another state would make it inter-state). | 06a §2.6; 06b DO-28 |
| R5-3 | **MR-18 still treats the master's flag as a backstop** until the daily job copies it onto the item | So a central tightening applies at once, not the next morning | 06a §6.5, MR-18 |
| R5-4 | **Merging patients is owner-only and signed with the PIN;** merges can be undone | It combines two people's medication histories | 06a §3.7, §9.2 |
| R5-5 | **Only PINs get the pepper; passwords keep plain scrypt** | 8+ character passwords are far costlier to guess offline than 6-digit PINs; the same mechanism can be added later | 06a §3.12 |
| R5-6 | **Object storage threshold: 10 GB in total, with an alert at 8 GB** | About 35,000 photos at ~300 KB; it keeps backups and the restore drill quick on Railway | 06a §6.2 |
| R5-7 | **The column stays `org_id`** (the review wrote `organisation_id`) | It is used consistently across the spec and the `app.org_id` setting; renaming it is mechanical if wanted | 06a §5 |

---

## 2. What Rev 4 replaced

| The earlier, Ritu-hosted drafts used | Rev 4 (standalone) uses |
|---|---|
| Ritu Desk's database (D-0) | its own Postgres, shared by every organisation (D-24, D-25) |
| Ritu Desk's organisations and clinics, from its Spec 07 | its own `organisations` + `premises` |
| Ritu Desk's staff accounts, sessions and role map | its own `staff_users`, `sessions`, `devices`, `device_state`, `org_roles` + `role_grants` |
| Ritu Desk's single re-auth PIN | its own re-auth grants, with a **signing PIN separate from the switch PIN** |
| device switching from Ritu Desk's Spec 07 (a prerequisite) | its own lock screen, idle lock and per-user PIN limit (06a §3.5–3.8) |
| Ritu Desk's audit log | its own append-only `audit_log`, which the app role does not own |
| Ritu Desk's patients | its own minimal `patients` (name, phone; address/DOB only when a register needs them) |
| Ritu Desk's doctors | its own `prescribers` (`INTERNAL` / `EXTERNAL`) |
| prescriptions issued in Ritu Desk | its own `prescriptions` (photo or manual), `prescription_lines`, `prescription_images` |
| Ritu Desk's appointments, treatments and documents | none; `procedure_types` label procedure uses |
| cross-database ownership triggers | composite FKs everywhere |
| Ritu Desk's feature switches | none; an organisation is live once its premises are configured |
| Ritu Desk's PDF engine | an HTML print view + CSV |
| Ritu Desk's migration numbering | its own `001+`, a checksummed runner that fails closed |
| Ritu Desk's Spec 07 before PR 1 | none (D-29); the identity foundation is 06a §2–§4 |

---

## 3. Conflicts between the brief and reality

| ID | Conflict | Status |
|---|---|---|
| C-1 | One codebase assumed; two stacks found | superseded by D-24 (its own codebase, on the desk's stack) |
| C-2 | Clinic from a Clerk org claim | its own sign-in; Clerk rejected (06a §3.9) |
| C-3 | Spec 05's ORM guard vs raw SQL | resolved (D-8, RLS) |
| C-4 | A per-user baseline vs clinic-wide stock | resolved (D-1) |
| C-5 | "Reuse the existing role model" | withdrawn (no desk); hybrid roles (06a §4.1) |
| C-6 | Append-only ledger vs truncating tests | resolved (the harness truncates as the migrator) |
| C-7 | Paise vs rupee conventions | resolved (D-5, D-15) |
| C-8 | No job runner | open, OQ-17 |
| C-9 | Migration-runner hygiene | resolved: its own runner fails the deploy |
| C-10 | "Ritu Desk owns appointments" | withdrawn (this app has no appointments) |
| C-11 | The database layout vs the tenant model | resolved (D-25: one shared database) |
| C-12 | The brief's data model | D-3 |
| C-13 | The expired-batch rule | resolved (D-4, D-14) |
| C-14 | No WhatsApp consent handling | open; blocks any patient messaging (Phase 2) |
| C-15 | The voice assistant's medical-advice guard vs an availability tool | withdrawn (no voice link) |
| C-16 | Logging of inputs; `Number()` on amounts | resolved (06b DH-01, DH-04, DH-11) |
| C-17 | Mode on the clinic vs on the premises | resolved (D-6) |
| C-18 | Down migrations | resolved (D-21: none) |
| C-19 | An error shape with no code | resolved (06a §5) |
| C-20 | Migration numbering | resolved (its own 001+) |
| C-21 | Rev 2 was written against a stale desk checkout | resolved; rule in `CLAUDE.md` |
| C-22 | D-2 ("permissions as data") vs the desk's `roles.ts` | resolved (hybrid, 06a §4.1) |
| C-23 | D-6 ("business = tenant") vs "clinic = branch" | resolved (new `organisations` + `premises`) |
| C-24 | The `rx_prescriptions` FK blocks a cross-branch prescription | withdrawn (its own prescriptions are org-level) |
| **C-25** | **The brief assumed a Ritu Desk module** | resolved by D-24 |

---

## 4. Open questions

**Resolved:**
- OQ-28 → D-23 (round 3).
- OQ-16 → D-4, D-10 … D-13.
- OQ-23 → D-17.
- OQ-25 → D-19.
- OQ-26 → D-20.
- OQ-4 → D-6.
- OQ-6 → D-1.
- OQ-7 → D-2 / R4-10.
- OQ-12 → D-7 (still conditional on OQ-1).
- OQ-18 → R4-8.
- OQ-20 → the session's active person (06a §5).
- **OQ-31 → D-37 (round 5):** the repo moves to the Engageo GitHub organisation; hosting is its own Railway project. The domain is now OQ-37.
- **OQ-36 → D-36 (round 5):** name + phone matching and a merge tool in v1.
- **OQ-34, its threshold half → D-35 (round 5):** photos move to object storage at 10 GB. Retention stays open.

**Withdrawn with D-24:** OQ-2 (whether desk `invoices` were real): there is no desk link.

| ID | Question | Assumed | Blocks |
|---|---|---|---|
| **OQ-1** | Which premises goes first, under which mode? Does the pilot clinic dispense at all? Does it inject in-clinic? This decides P1-C. | its first premises, `RMP_OWN_PATIENTS`; P1-C included | PR 6 |
| **OQ-3** | GST treatment of in-clinic dispensing; needs a CA | rate snapshot only | billing |
| **OQ-5** | Who curates `medicine_master`, and from which **licensed** source? NLEM 2022 (public, generics only) is a start; brand data needs a licence. | an empty master + custom items + NLEM generics | PR 2 seed |
| **OQ-8** | Counsel's review of the mode rules, the register formats and the prescription rules (MR-18/21). Who has prepared registers for an inspection? | the brief's rules | go-live |
| **OQ-9** | Extra H1 fields per state advisory (Gujarat, Maharashtra) | `{}` per premises | go-live |
| **OQ-10** | Retail cosmeceuticals to walk-ins at an RMP premises? | no | PR 6 |
| **OQ-11** | DPDP erasure vs register retention, now including prescription photos | snapshots and photos kept for the register period; erasure is a founder decision | PR 3 |
| **OQ-13** | Supplier-licence and manufacturer rules at a `CONSUMABLES_ONLY` premises? | not applied | PR 5 |
| **OQ-14** | GST per HSN as a second global table? | per organisation | PR 2 |
| **OQ-15** | A batch re-arriving with a revised MRP | reject | PR 5 |
| **OQ-17** | Job runner | a Railway cron service → a `tsx` script as `pharmacy_jobs` | PR 7 |
| **OQ-19** | Pharmacy-software import adapters; `exceljs` for XLSX | the generic template | PR 8 |
| **OQ-21** | At an RMP premises, who may press Dispense (Schedule K direct supervision)? | the prescriber is the supervising RMP; reception records it | PR 6 |
| **OQ-22** | Is it acceptable that a reversed entry stays in the H1 register, marked? | kept, marked | PR 7 |
| **OQ-24** | Does a **signed DPA** exist with each organisation that will use this app? | no; it gates go-live | go-live |
| **OQ-27** | **(D-16)** Ask the pilot clinic's doctor whether they ever inject from an opened vial past the label's in-use time. If yes, choose `BLOCK` or `DOCTOR_OVERRIDE`. | `BLOCK` | P1-C |
| **OQ-29** | **(D-23)** A **custom** item (no master link) cannot inherit the central `requires_prescription` flag, so an organisation could create "isotretinoin" as a custom item and bypass MR-18. Options:<br>(a) when a custom MEDICINE/INJECTABLE item is created, the deterministic master matcher proposes links; if a top candidate is flagged X or `requires_prescription`, saving it unlinked needs an owner override, which is audited and reported to Engageo curation;<br>(b) at an RMP premises, custom MEDICINE/INJECTABLE items cannot be dispensed until linked or reviewed. | (a) | PR 2 |
| **OQ-30** | **New (D-28): Ritu Desk integration later.** Should a clinic that uses both apps share one login and sync patients through an API?<br>**Options for login:**<br>• keep separate logins (v1);<br>• make Ritu Desk an identity provider this app trusts;<br>• have both apps trust a shared Engageo identity service.<br>**Patient sync:** one-way from desk to pharmacy over an API, with a link table, a defined master for name and phone, and the DPA covering the transfer.<br>A shared login would depend on Ritu Desk's own identity work. Nothing in v1 blocks either option. | separate logins; no sync | nothing in v1 |
| **OQ-32** | **New (counsel): prescription validity.**<br>• A maximum age per premises (default none).<br>• Dispensing a line in parts, up to the prescribed total.<br>• A patient return not restoring quantity.<br>• Whether a Schedule X prescription may be dispensed more than once. | as 06a MR-18 / MR-21 | go-live |
| **OQ-33** | **New: MR-18 evidence.** Is "a photo **or** the prescriber's PIN verification" enough, or should Schedule X need both? | either | PR 6 |
| **OQ-34** | **Photo retention** (the storage threshold is now D-35): how long prescription photos are kept, and whether that follows the register's retention | kept as long as the register | PR 3 |
| **OQ-35** | **New:** at the pilot clinic, will the doctor sign in personally on the front-desk PC (needed to verify manual prescriptions and for the vial override), or does reception do everything? | the doctor signs in daily and switches by PIN | PR 3 UI |
| **OQ-37** | **New:** the app's domain name | none chosen | PR 0 deploy |

---

## 5. Milestones

### Milestone 1: one premises runs its dispensary on it every day (D-38, D-39)

**In:**
- **Sign-in:** personal password sign-in (06a §3.3, password only); trusted PCs, the "Who's working?" screen, the idle lock, the switch PIN; the signing PIN with its pepper (R6-1).
- **Setup:** organisations (founder CLI), premises and their legal settings (`RMP_OWN_PATIENTS` only, R6-2), staff, memberships, roles and grant overrides, devices, the audit log.
- **Catalogue and stock:**
  - the minimal master (R6-5); items, units, suppliers;
  - batches (per premises), the ledger and its DB guards;
  - receiving stock (GRN, received now);
  - CSV import of opening stock (expired rows into quarantine).
- **People:**
  - patients (name + phone matching; the duplicate warning);
  - prescribers;
  - prescriptions: manual entry and photo, with browser compression, the 2 MB cap, and verification.
- **Dispensing:**
  - FEFO; the expiry block; the MRP ceiling;
  - MR-01 … 05, 08 … 11, 13, 14, 18 (`requires_prescription`), 19 … 22;
  - patient returns; write-offs (expiry, damage); reversals; idempotency.
- **Views:** stock overview, low stock, near expiry (computed live, no jobs); the H1 and purchase registers (print view and CSV).

**Later (everything else in Rev 5):**

| Milestone | Contents |
|---|---|
| **Pilot go-live** (after Milestone 1 is accepted) | Hosting in its own Railway project; DS-12 (no superuser DSN); the restore drill (06b DMG-10); `PIN_PEPPERS` set; the DPA (OQ-24); counsel's review (OQ-8, OQ-32); OQ-1 |
| **Milestone 2** | • Phone OTP, once the WhatsApp authentication template and the DLT sender header and template are approved.<br>• Backdating, including a GRN's `received_at`, and the entry-lag report.<br>• Stock-count adjustments and manual opening balances; supplier returns.<br>• The patient merge tool.<br>• Procedure use with `CONSUMABLES_ONLY` and procedure types; opened containers (P1-C, if OQ-1 confirms).<br>• GST tax rates.<br>• The outbox, daily and weekly jobs, reconciliation, purges.<br>• Master corrections.<br>• Valuation, consumption and non-moving reports.<br>• XLSX import. |
| **Milestone 3** | `LICENSED_PHARMACY`; same-state transfers (D-19); stock takes and purchase orders; consumption templates; per-premises reorder levels; a server PDF for registers; WhatsApp refill reminders (after opt-in and opt-out, C-14); object storage at 10 GB (D-35); temperature logging; Ritu Desk integration if OQ-30 says yes |

**How Milestone 1 is built:** 12 small PRs (06a §19). Each is on its own branch, based on the previous one, and each passes the full suite before the next starts. PR 1 stops for review.

### Go-live gates, for the first premises

1. A signed DPA (OQ-24).
2. Counsel's review of the mode rules, registers and prescription rules (OQ-8, OQ-32).
3. The restore drill is done (06b DMG-10).
4. No superuser DSN in any service (06b DS-12).
5. `PIN_PEPPERS` set as a Railway variable, and the pepper rotation rehearsed once on staging (06a §3.12).
6. OQ-1 is answered (and OQ-27 too, once P1-C is built).
7. **Phone OTP is not a gate for the pilot:** Milestone 1 signs in by password (D-39). It becomes a gate for Milestone 2's OTP sign-in.
