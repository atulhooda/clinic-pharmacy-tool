# medicine_master sources

`scripts/load-master.cjs` loads **only** the files listed in the table below, as `pharmacy_curator`
(06a §6.3, R6-5). Every row of a file must name its source here; a source without a licence note
is not loaded (06b DG-07). Brand data needs a licence and is not in Milestone 1 (06 OQ-5).

| source | file | licence | notes |
|---|---|---|---|
| `d32-starting-values` | `d32-starting-values.json` | Generic (INN) names only; no third-party data. | The founder's D-32 starting values for `requires_prescription`. |
| `inn-generic-draft` | `inn-generic-draft.json` | Generic (INN) names only; no third-party data. | An engineering draft of common generics. Membership in NLEM 2022 and every schedule flag are **to be confirmed by the curator** before `verified` is set (06 OQ-5). |

## D-32 starting values

`requires_prescription` is true on every **oral** form of these salts and false on their topical
forms. This list is data: the code never names a drug (06b DG-11, DH-13).

<!-- d32-salts -->
- Isotretinoin
- Acitretin
<!-- /d32-salts -->

Oral dosage forms: `TABLET`, `CAPSULE`, `SYRUP`, `SUSPENSION`, `SOLUTION`, `DROPS`, `SACHET`, `POWDER`.

## Review status

Every row is loaded with `verified = false` and **no schedule flags**. A pharmacist reviews and sets
them through the curator tooling (Milestone 2's corrections, 06 R6-5); until then an organisation
adds flags on its own items (`extra_schedule_flags`), which can only add, never remove.
