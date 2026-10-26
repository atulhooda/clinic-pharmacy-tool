# Spec 06 — Clinic Pharmacy Tool: Index, Decisions, Open Questions

**Status:** **Rev 6.7**, 2026-10-22 (D-57: the desk ⇄ pharmacy stock sync; Rev 6.6 was 2026-10-19, D-53 … D-56; Rev 6.2 was 2026-10-08). **Milestone 1 is being built** (§5).
**Written against:** clinic-pharmacy-tool `origin/main` @ `1aaa2a1` (last fetched 2026-10-12; PRs 1–5, 7, 8, 8b and the Railway config; the remote has been unreachable since, so `main` here is the local branch). Rev 6.2 was written against `6f5ffb2` (2026-10-08, README only). Stack conventions from Ritu Desk `origin/main` @ `8bee594` (fetched 2026-10-08; no newer commits).
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
| D-24 | **A standalone app** with its own codebase (`clinic-pharmacy-tool`) and its own database, not a Ritu Desk module. The original brief's assumption was wrong. **Supersedes D-0.** (Still true after D-57: an HTTP integration, no shared database, package or code.) | 06a §0.10, §1 |
| D-25 | **Multi-tenant from the first migration:**<br>• organisations + premises;<br>• RLS;<br>• the app connecting as a non-superuser, non-owner role;<br>• one shared database, no per-branch databases. | 06a §2, §18; 06b DS, DMG |
| D-26 | **No Ritu Desk dependency.** Its own minimal patients (name, phone), its own prescribers (name, registration number, address, as the H1 register needs), and prescriptions as uploaded photos or manual entries. | 06a §6.2, §9.2; 06b DRX |
| D-27 | **Its own sign-in for a shared front-desk PC:**<br>• daily full sign-in;<br>• PIN switching;<br>• idle auto-lock;<br>• a signing PIN separate from the switch PIN.<br>Ideas borrowed from Spec 07; not its code or database. | 06a §3; 06b DN, DW, DPN, DQ, DAU |
| D-28 | **Ritu Desk integration is out of v1.** **Amended by D-57** (2026-10-22): the desk's bills move stock here over a signed HTTP call. Shared login and patient sync stay out (OQ-30). | OQ-30; 06a §17 |
| D-29 | **Spec 07 stays Ritu Desk work on its own track;** nothing in Spec 06 depends on it. (D-57 adds an HTTP call from the desk; no Spec 07 dependency.) | 06a §0.10, §17 |
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

### Round 7 (founder, 2026-10-08): applied in Rev 6.1

| ID | Decision | Reflected in |
|---|---|---|
| D-42 | **Stock-count corrections, including adding found stock, move into Milestone 1.** Supplier returns stay in Milestone 2. Supersedes R6-4. | §5; 06a §19 (PR 10); 06b §30 |
| D-43 | **Repo hygiene.** Confirm the repo's visibility before every push. Never put client names, patient data, security findings or infrastructure details in this repo; incident notes live only in the private Ritu Desk repo. The history was cleaned on 2026-10-08. | `CLAUDE.md` |
| D-44 | **Review cadence.** PR 1 is approved; PR 2 is reviewed on its own; after that, three PRs between reviews. | §5 |

### Round 8 (founder review of PR 2, 2026-10-08): applied in Rev 6.2

| ID | Decision | Reflected in |
|---|---|---|
| D-45 | **Failed sign-ins are counted per submitted username, whether or not the account exists.** After 5 failures the answer is "too many attempts, try again in 15 minutes" (429 `too_many_attempts` with `Retry-After`), the same for an existing and a non-existing username. Supersedes the Rev 4 rule that a paused account answers like a wrong password. Lands in PR 3, with tests for both cases. | 06a §3.3, §3.8, §6.1; 06b DN-03, DN-22, DN-23 |
| D-46 | **The repo is deleted and recreated** (same name, public) so that the commits from before the 2026-10-08 clean-up are no longer served by GitHub. Only the clean branches are pushed to it. | `CLAUDE.md` |
| — | PR 2 is approved. PRs 3–5 are next, then a review (D-44). | §5 |

### Round 9 (founder, passing on the pilot clinic's request, 2026-10-08): applied in Rev 6.2

| ID | Decision | Reflected in |
|---|---|---|
| D-47 | **A stock statement in Milestone 1:** for any period and premises, per item, **opening stock + new supply (received) − issued = balance**, with patient returns and the other movements (write-offs, count corrections, opening entries, reversals) in their own columns so the sum always balances. The clinic's words: "balance is important". The Stock page shows each item's balance as soon as stock moves (PR 7); the full statement, with print and CSV, comes with the other views (PR 11). | §5; 06a §14, §12.3 (E-45), §19; 06b DR-17 … 20, DX-81 |
| D-48 | **Insights in Milestone 1:** a page like the desk's Insights. For today, yesterday, this or last week, this or last month, the last 30 days or any range, each compared with the period before: what was sold (dispenses, patients served, units, sales value), the top items, sales by day and by prescriber, what was received, stock health (low stock, near expiry, expired, non-moving) and stock value at cost and at MRP. **The consumption, valuation and non-moving reports move from Milestone 2 into Milestone 1** to feed it. | §5; 06a §14, §12.3 (E-46), §19 (PR 12); 06b DR-08, DR-09, DR-21 … 24, DX-82 |

### Round 10 (founder, 2026-10-08): applied in Rev 6.2

| ID | Decision | Reflected in |
|---|---|---|
| D-49 | **Invoice generation in Milestone 1.** Every sale at a premises that bills gets a numbered bill for the patient, printed at the counter and reprintable: a tax invoice, a bill of supply or a plain bill, as the premises' GST position requires. A reversed sale cancels its bill; a patient return issues a credit note against it. A sales register, with HSN and document summaries, gives the clinic's CA the figures. **GST rates per HSN move from Milestone 2 into Milestone 1.** Supersedes "Phase 1 stores price snapshots only" (06a §17). | §5; 06a §6.4, §6.5, §6.7, §9.3, §11.5, §12.3 (E-47 … E-50), §14, §16, §17, §19 (PR 11); 06b DBL-01 … 16, DX-83 … 86 |
| D-50 | **Balances first.** The founder asked to see balances working: the ledger (PR 7) and receiving (PR 8) are built before patients and prescriptions (PR 6), and **the stock statement (E-45) moves into PR 8**, so the pilot clinic's own supplier bills show as balances in the local demo as early as possible. PR 6 follows PR 8. PR numbers stay as names; the migrations are renumbered in build order (06a §18). | §5; 06a §18, §19 |
| D-51 | **Reading supplier bills from a photo.** On the Receive screen, a photo or PDF of a supplier's bill can be read to pre-fill a draft delivery: the supplier, the invoice number and date, and each line's name, pack, batch, expiry, quantities, MRP, rate and GST. A person checks every line, matches it to an item and posts it. The reader never posts, never creates an item or a supplier, and never reads a prescription. **Amends principle 7 (06a §0) for supplier bills only.** | 06a §0, §12.2, §12.3 (E-51), §16, §19 (PR 8b); 06b DBR-01 … 08, DX-87 |
| D-52 | **Hosting for the pilot: in the pilot clinic's existing Railway project,** as services of its own: a new Postgres (≥ 15) and the web app. They sit beside the clinic's other services and touch none of them: their own database, their own variables, no reference to any other service's variables. **Overrides D-37's "its own project" for the pilot.** Before a second organisation is onboarded, the app moves to a project of its own (a dump and restore of its database; the app keeps no project-specific state). Deploys come from GitHub once the repo is recreated (D-46), from a deploy branch (the last built PR plus the Railway config) until the PRs are merged. The address is Railway's generated one for now (OQ-37). The go-live gates (§5) still apply before real patient data is entered. | §5; 06a §1.3 |
| D-53 | **Stock can be set by count before dispensing is built (PR 10a, founder 2026-10-12).** The pilot needs its shelf stock in the app now, so the count kinds of E-34 are pulled forward from PR 10: a person counts one batch (or a new one) and enters the count; the service, under the balance locks, records **opening stock** on a key with no movement yet, or a **count correction** (`STOCKTAKE_ADJUSTMENT`) of the difference, with a reason from §7.1. Signed with the `stock.adjust` grant for the premises (D-33); never backdated; expired stock goes to quarantine (D-14); nothing is overwritten. `stock_adjustments` becomes migration **023** and the later Milestone 1 migrations shift by one (06a §18). The write-off kinds, reversals and patient returns stay in PR 10. Also from 2026-10-12: built PRs go straight to `main` (founder), and `main` is what is deployed. | §5; 06a §9.3, §18, §19 |
| D-54 | **Medicines given to patients and medicines used in the clinic are kept apart (founder, 2026-10-19).** Each item says what it is for: **given to patients** (dispensed), **used in the clinic** during treatment (procedures, IV drips, consultations), or **both**. Until someone chooses, injectables and consumables count as used in the clinic and everything else as given to patients. The Stock page has a tab for each side; an item marked both is in each. PR 9's dispense offers only items given to patients (or both); Milestone 2's procedure use, only items used in the clinic (or both). It is a nullable column on `items` (migration 024; the later migrations shift by one). In the same change, Suppliers moves under Receive as a tab, since deliveries come from suppliers. | §5; 06a §6.5, §18, §19 |
| D-55 | **Stock can be counted before its batch details are known (founder, 2026-10-19: "I just want to change the quantity").** The pilot's stock list has quantities but, for most products, no batch number, expiry or MRP. A count without them goes on **one placeholder batch per item and premises**, marked `details_pending` (migration 025), with fixed values the app never shows: number `DETAILS PENDING` (reserved: no real batch may take it), expiry 2099-12-31 (never expired or near expiry), MRP 1 paisa per base unit. The Stock page marks such items **Details pending**; the stock counts in every balance. Until the details are read off the pack, the app cannot warn about that stock's expiry, and PR 9 will not dispense from a placeholder (to be confirmed when PR 9 is built). **Add details** records them later: one signed document moves a quantity (all of it by default) from the placeholder onto the real batch, as two count corrections with the reason `BATCH_DETAILS_RECORDED`; expired stock lands in quarantine; repeat for each batch on the shelf. A new batch still prefers the details on the newest bill of the item (the batch hint). | §5; 06a §6.6, §18 |
| D-56 | **An item can carry a short note (founder, 2026-10-19).** Free text, at most 300 characters, about the product (never a patient): shown under its name on the Stock list and editable from its page. First use: the in-house items were added with no quantities and a note asking the clinic to enter them. Migration 026; the later migrations shift by one. | §5; 06a §6.5, §18 |

### Round 11 (founder, 2026-10-22): applied in Rev 6.7

| ID | Decision | Reflected in |
|---|---|---|
| D-57 | **The desk is the only billing system; its bills move stock here (the desk ⇄ pharmacy stock sync, v1).** A premises fed by the desk does not get this app's patient billing (D-49 / PR 11 is not built for it). **An HTTP integration with the desk is allowed:** the desk calls this app server to server, signed with a shared key (HMAC-SHA256, a ±120 s timestamp window and a single-use nonce). **Still no shared database, no shared package and no desk code in this repo** (D-24 stands; D-28 and D-29 are amended only so far). v1 moves stock only for **retail products given to patients** (category `RETAIL_PRODUCT`, `use_for` PATIENTS, BOTH or the default). Prices stay in the desk's price list; the desk warns, never blocks, when a price is above the highest batch MRP this app reports. Three signed endpoints, all 404 unless `DESK_SYNC_KEY` (≥ 32 characters), `DESK_SYNC_ORG_SLUG` and `DESK_SYNC_PREMISES_ID` are set: the items list (E-52), sales (E-53) and returns (E-54). A sale line takes its stock by FEFO from the premises' default store, **all of it or none of it**: a line that cannot be fully allocated (or whose stock is only on a placeholder batch, D-55) posts nothing and is kept short; a line that is not a sellable item is rejected. Each line is idempotent on (bill, line) and each return line on (credit note, line); a return puts back no more than its bill line took. Every movement names a system actor, **"Ritu Desk"**, a staff row that can never sign in (migration 027). A **Desk sales** page (`stock.view`) lists short and rejected lines; **Retry** (`stock.adjust`, signing PIN) allocates again once the stock is counted or received (E-55, E-56). Migrations 027 and 028; the later Milestone 1 migrations shift by two. Desk infrastructure details (hosts, keys) never enter this repo. | §5; 06a §6.1, §6.7, §9.3, §12.2, §12.3 (E-52 … E-56), §12.5, §17, §18; 06b DX-88, DX-89, §24.3 (DDS-01 … 17) |
| D-58 | **Write-offs come early (founder, 2026-10-26).** E-34's write-off kinds are pulled forward from PR 10: an **expiry write-off** (reason `EXPIRED`; only an expired batch, L-7) and a **damage write-off** (§7.1's damage reasons), quarantine first, signed with the `stock.writeoff` grant for the premises. It is the only way stock leaves quarantine (L-20). The Stock page offers **Write off** on an expired batch. First use: 9 units of a batch entered with a past expiry by mistake. No migration (the kinds were already in 023's CHECK). | §5; 06a §9.3 |

### Engineer's calls for the desk sync (D-57; veto any)

| ID | Call | Why |
|---|---|---|
| R11-1 | **A return is a `PATIENT_RETURN` movement per sale allocation** (reference `DESK_RETURN_ALLOCATION`), newest allocation first, not a `REVERSAL` | A REVERSAL mirrors its original exactly and at most once (L-8), so it cannot express a partial return or a second credit note on the same line. A trigger caps what comes back per allocation at what it took. |
| R11-2 | **Returned stock whose batch has expired by the return date goes to quarantine** (otherwise to the location it left) | D-14: expired stock never sits on the shelf |
| R11-3 | **Movements are dated when the pharmacy receives the bill,** not the bill's `issuedAt` (kept on the line) | The desk may send a bill late (retry with backoff); dating to `issuedAt` would hit the backdating cap and the as-of check (§11.4) for no gain |
| R11-4 | **`stock_movements_reference` is widened in place:** dropped and re-added under the same name in one statement. R6-8 now allows that for a CHECK that only admits more; the migration check (06b DMG-08) accepts exactly that shape. | A CHECK cannot be widened additively; one statement leaves no moment without it |
| R11-5 | **The items list reports `dispensableBase` as what a sale can take** (the default store, unexpired, not a placeholder) and `maxMrpPaisePerBase` rounded up, over batches with stock that is neither quarantined, expired nor a placeholder | So the desk's numbers match what E-53 will do, and the warning never fires on rounding |
| R11-6 | **Signature failures answer 401 with a reason code** (`bad_signature`, `stale_timestamp`, `nonce_reused`); a misconfigured organisation or premises answers 503 `desk_sync_misconfigured` | So the desk side can tell a clock problem from a key problem; nothing in the answer names a tenant |
| R11-7 | **A credit note on a line that never took stock closes it (`CANCELLED`, reason `credited`)**, and Retry refuses any line a credit note has reached (409 `DESK_SALE_CREDITED`; the DB guard too) | Found by the end-to-end run against the desk: otherwise a short line credited at the desk could later be resolved and send stock out for a refunded sale |
| R11-8 | **A credit whose sale has not arrived is a retryable 409 `sale_not_received`, storing nothing** (no final `unknown_line`) | The desk's outbox gives no order guarantee; a pharmacy cannot prove a bill will never arrive, so it must not close the credit early |
| R11-9 | **Nonces are kept, and only the ±120 s window gives them meaning;** the body is capped at 256 KB while it is read, and the signature is checked before any database work (06a §12.5) | DMG-07 forbids the app role any DELETE; older nonce rows are inert. A purge belongs to the jobs role when the jobs runner exists. |

### Engineer's calls in Rev 6.2 (under D-3; veto any)

| ID | Call | Why |
|---|---|---|
| R6-10 | **The per-username counter lives in its own table, `sign_in_throttle`, keyed by an HMAC of the submitted login** (a key derived from `SESSION_SECRET`), never the login in clear | A mistyped login can be a password or a name typed in the wrong box; it must not sit in the database in clear (the same reason it is never logged, 06b DN-02) |
| R6-11 | **`staff_users.password_failures` and `password_paused_until` stay, unused** | Migrations never drop a column (R6-8); nothing has been released, so a later contract migration can remove them |
| R6-12 | **The 5th failure itself answers 429,** and so does every try during the next 15 minutes, including a right password. Failures count in a 15-minute window from the first one; a success clears the count. | The person learns about the pause when it starts. Both cases run the same code path, so the answer reveals nothing about whether the account exists. |
| R6-13 | **The trusted-device allowance stays** (5 failures per username per device before they count, DN-05), keyed by the submitted username too | A mistyping colleague at the front desk should not lock someone out; keyed by username, it treats real and unknown usernames alike |
| R6-14 | **A global census of PIN hashes per pepper version, `pin_pepper_census`,** kept by a trigger | The startup check must know which pepper versions stored hashes use before any session exists. A count per version holds no tenant data, so it needs no new door past RLS (06a §2.4 stays as it is). |

### Engineer's calls made while building PRs 3–5 (under D-3; veto any)

| ID | Call | Why |
|---|---|---|
| R7-1 | **Only an owner can give or take the `owner` role** (M-06, M-07: 403 `forbidden` otherwise) | A custom role holding `staff.manage` could otherwise promote someone to owner and so gain every permission |
| R7-2 | **Administration writes get their `Idempotency-Key` in PR 7,** with the idempotency table (06a §12.2) | Until then every signed write is still replay-proof: its re-auth grant is single use, so a replay gets 401 `reauth_required`. M-08 (end sessions) needs no grant and is naturally idempotent. |
| R7-3 | **Hindi and Gujarati are offered only after a native speaker has reviewed them** (06a §16) | The kit's few strings came with the desk's drafts, themselves still unreviewed; no unreviewed translation reaches a clinic |
| R7-4 | **The UI kit copy leaves out the desk's appointment and SLA colour tokens and its product-named token.** It includes the desk's shell (sidebar, top bar, page heads) and its fonts, through `next/font`, self-hosted at build. | The tokens describe the desk's domain, not this app's. The shell and the fonts are what make both apps look alike (R4-9); `next/font` serves the fonts from the app itself, so no page calls a third party. (Until 2026-10-08 this call kept the system fonts; the founder asked for the desk's look.) |
| R7-5 | **In Milestone 1 an item's identity never changes after creation** (base unit, batch tracking, master link) | A unit hierarchy and every future batch are defined against the base unit; a different identity is a different item. The DB freeze (once stock has moved) still comes with the ledger. |
| R7-6 | **The minimal master is loaded unverified and without schedule flags;** only D-32's `requires_prescription` starting values are set | Schedule classifications are regulatory facts; they are set by the curator from a reviewed source, not drafted by the engineering side (06 OQ-5). Until then an organisation adds flags on its own items. |

### Engineer's calls for billing and the build order (D-49, D-50; veto any)

| ID | Call | Why |
|---|---|---|
| R8-1 | **Each premises chooses its billing mode explicitly, with no default:** `TAX_INVOICE`, `BILL_OF_SUPPLY_EXEMPT`, `BILL_OF_SUPPLY_COMPOSITION` or `BILL_UNREGISTERED`. Unset means the premises does not bill. Choosing or changing it is a premises legal setting (signing PIN, history row). | What a clinic must issue depends on its GST registration and on how its CA treats in-clinic dispensing (OQ-3). Supporting all four lets the build go ahead; the CA picks one before go-live. |
| R8-2 | **One bill per dispense, issued in the dispense's own transaction,** from a gapless series per premises and financial year: `{prefix}/{FY}/{seq}`, e.g. `AG/2627/00001`, at most 16 characters. Credit notes have their own series (`AG/2627/C0001`). | GST asks for a consecutive serial number, unique within the financial year, of at most 16 characters. Issuing inside the dispense's transaction means a failed dispense uses no number and no sale goes without its bill. |
| R8-3 | **Prices include GST; the tax is worked back per line** in integers (06a §11.5), CGST taking the odd paisa. The amount payable may be rounded to the nearest rupee (a premises setting), shown as a round-off. | The MRP includes all taxes and §11.2 already caps every price at it, so the price the patient sees is tax-inclusive. Working per line keeps every line exact: taxable + CGST + SGST = net. |
| R8-4 | **Bills are immutable.** A reversal cancels its bill, and the number is never reused; a patient return issues a credit note valued in proportion to the quantity, the last return on a line taking exactly what remains. | The rule of every posted document (06a §6.7). A credit note is how GST corrects a sale already billed. |
| R8-5 | **Where a premises bills, every dispense line needs a price** (422 `PRICE_REQUIRED`; the screen pre-fills the MRP ceiling), **and under `TAX_INVOICE` every item needs a GST rate on the day** (422 `TAX_RATE_MISSING`; the preview says so first, and the Items page marks items without a rate). | A bill with a missing price or a guessed rate is worse than a visible stop at the counter. |
| R8-6 | **Printed, never sent, and no money handling:** an HTML print view in A5 and 80 mm roll layouts ("Save as PDF" is the browser's); never over WhatsApp; no payments, dues or refunds recorded. | R4-8 (no server PDF) and the 06a §17 boundary. A cash register is its own feature. |
| R8-7 | **The sales register holds no patient data,** so it is a `stock.reports` view; the bill itself names the patient and is read under `dispense.view`. Bills are kept like registers: never deleted, including after an erasure request, for the GST retention period (OQ-11). | The CA needs numbers, not names. |
| R8-8 | **A number prefix is unique in the organisation for good:** once used, it cannot move to another premises. | Two premises under one GSTIN must never print the same number. |
| R8-9 | **D-50's order:** PRs 7 and 8 before PR 6, PR 6 before PR 9. The migrations are renumbered in build order (019–021 the ledger, 022 receiving, 023–025 people), because the runner requires contiguous numbers (06b DMG-12). | Nothing in the ledger or in receiving reads patients or prescriptions; dispensing (PR 9) needs all three. |
| R8-10 | **The reader is Anthropic's Claude, a vision model, over its API,** called by the server with the photo. The key is `ANTHROPIC_API_KEY`; the model is `BILL_READER_MODEL` (default `claude-opus-5-5`). Without a key the screen says reading is not set up (503 `BILL_READER_NOT_CONFIGURED`); typing a delivery works as before. | Bills are dense tables of small print; a general vision model reads them far better than local OCR, and its output is only ever a draft a person checks. It is the app's first third-party data flow: bill images only (no patient data), not stored by the app; the DPA lists the processor (OQ-24). |
| R8-11 | **Matching is the app's, not the model's:** the supplier by GSTIN, then by name; each line's item by trigram similarity of the name (up to three candidates; none preselected below 0.45); the pack by its size (`10 TAB` → the strip of 10). | The model transcribes; deterministic code decides what the text refers to, and a test can pin it. |
| R8-12 | **E-51 writes nothing,** so it needs no idempotency key (one of 06a §12.2's read-only exemptions). The draft is created by E-23 as usual, and posting runs every rule a typed draft does. | A second reading is harmless; there is one path that creates drafts. |
| R8-13 | **Logs hold counts and timings only,** never the bill's text; the image is held in memory for the call and dropped. | §9.1's log rule. |

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
| R6-4 | ~~Stock-count adjustments and supplier returns are Milestone 2.~~ **Superseded by D-42:** count corrections (including found stock) are Milestone 1; supplier returns stay Milestone 2. | — |
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
| **OQ-3** | GST treatment of in-clinic dispensing; needs a CA. **Since D-49** the CA confirms, for each premises that bills: its billing mode (R8-1); the document titles and the composition legend (06a §11.5); the rounding (R8-3); whether a patient's address must appear above some value; and whether copies need labels. | each premises' mode as chosen; the wording in 06a §11.5 | go-live (billing) |
| **OQ-5** | Who curates `medicine_master`, and from which **licensed** source? NLEM 2022 (public, generics only) is a start; brand data needs a licence. | an empty master + custom items + NLEM generics | PR 2 seed |
| **OQ-8** | Counsel's review of the mode rules, the register formats and the prescription rules (MR-18/21). Who has prepared registers for an inspection? | the brief's rules | go-live |
| **OQ-9** | Extra H1 fields per state advisory (Gujarat, Maharashtra) | `{}` per premises | go-live |
| **OQ-10** | Retail cosmeceuticals to walk-ins at an RMP premises? | no | PR 6 |
| **OQ-11** | DPDP erasure vs register retention, now including prescription photos and bills (D-49) | snapshots and photos kept for the register period, bills for the GST retention period; erasure is a founder decision | PR 3 |
| **OQ-13** | Supplier-licence and manufacturer rules at a `CONSUMABLES_ONLY` premises? | not applied | PR 5 |
| **OQ-14** | GST per HSN as a second global table? | per organisation | PR 11 |
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
  - patient returns; write-offs (expiry, damage); **stock-count corrections**, up or down, including found stock, which may create its batch (D-42); reversals; idempotency.
- **Views:** stock overview, low stock, near expiry (computed live, no jobs); **the stock statement** (opening + received − issued = balance, per item and period, D-47); **Insights** (sales by period with comparisons, top items, by prescriber, stock health, stock value: D-48); the H1 and purchase registers (print view and CSV).
- **Billing (D-49):** a numbered bill for every sale at a premises that bills (tax invoice, bill of supply or bill), cancelled with its reversal; credit notes for patient returns; GST rates per HSN; the sales register with HSN and document summaries (print and CSV).

**Later (everything else in Rev 5):**

| Milestone | Contents |
|---|---|
| **Pilot go-live** (after Milestone 1 is accepted) | Hosting (D-52: its own services in the pilot clinic's Railway project, a project of its own before a second organisation); DS-12 (no superuser DSN); the restore drill (06b DMG-10); `PIN_PEPPERS` set; the DPA (OQ-24); counsel's review (OQ-8, OQ-32); OQ-1 |
| **Milestone 2** | • Phone OTP, once the WhatsApp authentication template and the DLT sender header and template are approved.<br>• Backdating, including a GRN's `received_at`, and the entry-lag report.<br>• Manual opening balances (outside an import); supplier returns.<br>• The patient merge tool.<br>• Procedure use with `CONSUMABLES_ONLY` and procedure types; opened containers (P1-C, if OQ-1 confirms).<br>• The outbox, daily and weekly jobs, reconciliation, purges.<br>• Master corrections.<br>• XLSX import. |
| **Milestone 3** | `LICENSED_PHARMACY`; same-state transfers (D-19); stock takes and purchase orders; consumption templates; per-premises reorder levels; a server PDF for registers; WhatsApp refill reminders (after opt-in and opt-out, C-14); object storage at 10 GB (D-35); temperature logging; Ritu Desk integration if OQ-30 says yes |

**How Milestone 1 is built:** 16 small PRs (06a §19), in the order D-50 and D-51 set: 1–5, 7, 8, 8b, 6, 9, 10, then 11–15. Each is on its own branch, based on the previous one, and each passes the full suite before the next starts. Reviews (D-44): PR 1 and PR 2 approved; then every three PRs (PRs 3–5 next).

### Go-live gates, for the first premises

1. A signed DPA (OQ-24).
2. Counsel's review of the mode rules, registers and prescription rules (OQ-8, OQ-32).
3. The restore drill is done (06b DMG-10).
4. No superuser DSN in any service (06b DS-12).
5. `PIN_PEPPERS` set as a Railway variable, and the pepper rotation rehearsed once on staging (06a §3.12).
6. OQ-1 is answered (and OQ-27 too, once P1-C is built).
7. **Phone OTP is not a gate for the pilot:** Milestone 1 signs in by password (D-39). It becomes a gate for Milestone 2's OTP sign-in.
8. For each premises that bills, the clinic's CA has confirmed its billing mode and the bill's wording (OQ-3).
