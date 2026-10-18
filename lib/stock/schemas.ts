import { UUID_PATTERN, type Rule } from '../http/body';
import { HttpError } from '../http/errors';
import { CATEGORIES, BASE_UNITS, SCHEDULE_FLAGS, STORAGE, USE_FOR } from './items';

/** Request schemas shared by the dispensary routes (strictBody: unknown keys are 422). */
const date = /^\d{4}-\d{2}-\d{2}$/;
export const STOCK_SETTINGS = {
  nearExpiryWindowsDays: { type: 'int[]', min: 1, max: 3, itemMin: 1, itemMax: 365 },
  dispenseReversalWindowHours: { type: 'int', min: 0, max: 168 },
  backdateReasonAfterMinutes: { type: 'int', min: 10, max: 1440 },
  scheduledEntryMaxMinutes: { type: 'int', min: 0, max: 120 },
  backdateWindowHours: { type: 'int', min: 0, max: 168 },
  backdateExtendedWindowHours: { type: 'int', min: 0, max: 168 },
  procedureUsePatientLink: { type: 'string', pattern: /^(OPTIONAL|REQUIRED_FOR_INJECTABLES|REQUIRED)$/ },
  openedContainerLapsePolicy: { type: 'string', pattern: /^(BLOCK|DOCTOR_OVERRIDE)$/ },
  intraStateTransfersEnabled: { type: 'bool' },
} as const satisfies Record<string, Rule>;

export const optional = <S extends Record<string, Rule>>(s: S) =>
  Object.fromEntries(Object.entries(s).map(([k, r]) => [k, { ...r, optional: true }])) as { [K in keyof S]: S[K] & { optional: true } };

export const PREMISES_SETTINGS = {
  dispensingMode: { type: 'string', pattern: /^(RMP_OWN_PATIENTS|LICENSED_PHARMACY|CONSUMABLES_ONLY)$/ },
  ndpsLicenceNo: { type: 'string', max: 60, nullable: true },
  ndpsLicenceValidTill: { type: 'string', pattern: date, nullable: true },
  scheduleXLicenceNo: { type: 'string', max: 60, nullable: true },
  scheduleXLicenceValidTill: { type: 'string', pattern: date, nullable: true },
  h1RegisterExtraFields: { type: 'string[]', max: 4, oneOf: ['PATIENT_ADDRESS', 'PATIENT_AGE', 'PATIENT_DOB', 'PRESCRIPTION_DATE'] },
  prescriptionMaxAgeDays: { type: 'int', min: 1, max: 365, nullable: true },
} as const satisfies Record<string, Rule>;

const enumPattern = (xs: readonly string[]) => new RegExp(`^(${xs.join('|')})$`);
const ITEM_COMMON = {
  category: { type: 'string', pattern: enumPattern(CATEGORIES) },
  displayName: { type: 'string', min: 1, max: 120 },
  extraScheduleFlags: { type: 'string[]', max: 6, oneOf: SCHEDULE_FLAGS },
  requiresPrescription: { type: 'bool' },
  customManufacturerName: { type: 'string', max: 200, nullable: true },
  customManufacturerAddress: { type: 'string', max: 500, nullable: true },
  hsnCodeOverride: { type: 'string', pattern: /^[0-9]{4,8}$/, nullable: true },
  storageCondition: { type: 'string', pattern: enumPattern(STORAGE), nullable: true },
  reorderLevel: { type: 'int', min: 0, max: 10_000_000, nullable: true },
  reorderQty: { type: 'int', min: 1, max: 10_000_000, nullable: true },
  rackLocation: { type: 'string', max: 40, nullable: true },
  useFor: { type: 'string', pattern: enumPattern(USE_FOR) },
} as const satisfies Record<string, Rule>;

export const ITEM_CREATE = {
  ...optional(ITEM_COMMON),
  category: ITEM_COMMON.category,
  displayName: ITEM_COMMON.displayName,
  masterId: { type: 'uuid', optional: true, nullable: true },
  baseUnit: { type: 'string', pattern: enumPattern(BASE_UNITS) },
  trackBatches: { type: 'bool', optional: true },
} as const satisfies Record<string, Rule>;

export const ITEM_PATCH = { ...optional(ITEM_COMMON), active: { type: 'bool', optional: true } } as const satisfies Record<string, Rule>;

export const SUPPLIER = {
  name: { type: 'string', min: 1, max: 120 },
  gstin: { type: 'string', pattern: /^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/, nullable: true },
  drugLicenceNumbers: { type: 'string[]', max: 10, itemMax: 60 },
  licenceValidTill: { type: 'string', pattern: date, nullable: true },
  address: { type: 'string', max: 500, nullable: true },
  contactName: { type: 'string', max: 120, nullable: true },
  contactPhone: { type: 'string', pattern: /^\+[1-9][0-9]{7,14}$/, nullable: true },
  contactEmail: { type: 'string', max: 200, pattern: /^[^@\s]+@[^@\s]+\.[^@\s]+$/, nullable: true },
  active: { type: 'bool' },
} as const satisfies Record<string, Rule>;

/** A path id that is not a UUID is simply not found (06a §12.1). */
export function pathId(v: string, code: string, message: string): string {
  if (!UUID_PATTERN.test(v)) throw new HttpError(404, code, message);
  return v.toLowerCase();
}
