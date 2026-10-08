import { withTenant } from '../db/tenant';
import { now } from '../clock';
import { HttpError } from '../http/errors';
import { writeAudit } from '../audit';
import { withSessionTx, type Session } from '../auth/guard';
import { consumeGrant } from '../auth/reauth';
import { requirePremises, checkViolation } from './scope';

/**
 * Dispensary settings (06a §6.4; E-01 … E-06). The organisation's stock settings come first
 * (E-02); then each premises chooses its dispensing mode explicitly (no default) and gets its
 * default store and quarantine locations (E-05). Milestone 1 supports RMP_OWN_PATIENTS only
 * (06 R6-2). Premises legal settings are signed with a `premises.legal_settings` grant and
 * audited in the same transaction; both tables keep an append-only history.
 */
export interface StockSettings {
  nearExpiryWindowsDays: number[];
  dispenseReversalWindowHours: number;
  backdateReasonAfterMinutes: number;
  scheduledEntryMaxMinutes: number;
  backdateWindowHours: number;
  backdateExtendedWindowHours: number;
  procedureUsePatientLink: 'OPTIONAL' | 'REQUIRED_FOR_INJECTABLES' | 'REQUIRED';
  openedContainerLapsePolicy: 'BLOCK' | 'DOCTOR_OVERRIDE';
  intraStateTransfersEnabled: boolean;
  version: number;
}
const STOCK_COLS = `near_expiry_windows_days AS "nearExpiryWindowsDays", dispense_reversal_window_hours AS "dispenseReversalWindowHours",
  backdate_reason_after_minutes AS "backdateReasonAfterMinutes", scheduled_entry_max_minutes AS "scheduledEntryMaxMinutes",
  backdate_window_hours AS "backdateWindowHours", backdate_extended_window_hours AS "backdateExtendedWindowHours",
  procedure_use_patient_link AS "procedureUsePatientLink", opened_container_lapse_policy AS "openedContainerLapsePolicy",
  intra_state_transfers_enabled AS "intraStateTransfersEnabled", version`;
const notConfigured = () => new HttpError(409, 'DISPENSARY_NOT_CONFIGURED', 'Set up the dispensary first.');
const versionOf = (ifMatch: string | null) => {
  if (!ifMatch) throw new HttpError(428, 'IF_MATCH_REQUIRED', 'Send the version you edited in If-Match.');
  return ifMatch.replace(/^W\//, '').replace(/"/g, '');
};

/** E-01 */
export async function getStockSettings(s: Session): Promise<StockSettings> {
  const r = await withTenant(s.orgId, async (db) => (await db.rows<StockSettings>(`SELECT ${STOCK_COLS} FROM stock_settings WHERE org_id = $1`, [s.orgId]))[0]);
  if (!r) throw notConfigured();
  return r;
}

type StockInput = Partial<Omit<StockSettings, 'version'>>;
const STOCK_MAP: Record<keyof StockInput, string> = {
  nearExpiryWindowsDays: 'near_expiry_windows_days', dispenseReversalWindowHours: 'dispense_reversal_window_hours',
  backdateReasonAfterMinutes: 'backdate_reason_after_minutes', scheduledEntryMaxMinutes: 'scheduled_entry_max_minutes',
  backdateWindowHours: 'backdate_window_hours', backdateExtendedWindowHours: 'backdate_extended_window_hours',
  procedureUsePatientLink: 'procedure_use_patient_link', openedContainerLapsePolicy: 'opened_container_lapse_policy',
  intraStateTransfersEnabled: 'intra_state_transfers_enabled',
};

/** E-02: create the organisation's stock settings (defaults, or the given values). */
export async function setupDispensary(s: Session, input: StockInput): Promise<StockSettings> {
  return withSessionTx(s, async (db) => {
    const exists = await db.rows('SELECT 1 FROM stock_settings WHERE org_id = $1', [s.orgId]);
    if (exists.length) throw new HttpError(409, 'ALREADY_CONFIGURED', 'The dispensary is already set up.');
    const keys = (Object.keys(input) as (keyof StockInput)[]).filter((k) => input[k] !== undefined);
    const cols = ['org_id', 'updated_by', 'updated_at', ...keys.map((k) => STOCK_MAP[k])];
    const vals = [s.orgId, s.staffUserId, now(), ...keys.map((k) => input[k])];
    const r = (await db.rows<StockSettings>(
      `INSERT INTO stock_settings (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${STOCK_COLS}`, vals)
      .catch(checkViolation))[0];
    await writeAudit(db, { orgId: s.orgId, action: 'stock.settings_created', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: s.orgId });
    return r;
  });
}

/** E-03: change stock settings (If-Match). */
export async function putStockSettings(s: Session, input: Required<StockInput>, ifMatch: string | null): Promise<StockSettings> {
  const version = versionOf(ifMatch);
  return withSessionTx(s, async (db) => {
    const cur = (await db.rows<StockSettings>(`SELECT ${STOCK_COLS} FROM stock_settings WHERE org_id = $1 FOR UPDATE`, [s.orgId]))[0];
    if (!cur) throw notConfigured();
    if (String(cur.version) !== version) throw new HttpError(412, 'VERSION_CONFLICT', 'Someone else changed these settings. Reload and try again.', { version: cur.version });
    const keys = (Object.keys(STOCK_MAP) as (keyof StockInput)[]).filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(input[k]));
    if (keys.length === 0) return cur;
    const sets = keys.map((k, i) => `${STOCK_MAP[k]} = $${i + 2}`).join(', ');
    const r = (await db.rows<StockSettings>(
      `UPDATE stock_settings SET ${sets}, version = version + 1, updated_by = $${keys.length + 2}, updated_at = $${keys.length + 3}
        WHERE org_id = $1 RETURNING ${STOCK_COLS}`, [s.orgId, ...keys.map((k) => input[k]), s.staffUserId, now()]).catch(checkViolation))[0];
    await writeAudit(db, { orgId: s.orgId, action: 'stock.settings_changed', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: s.orgId,
      detail: { fields: keys.map((k) => STOCK_MAP[k]), version: r.version } });
    return r;
  });
}

export type DispensingMode = 'RMP_OWN_PATIENTS' | 'LICENSED_PHARMACY' | 'CONSUMABLES_ONLY';
/** 06 R6-2: the modes Milestone 1 can run. */
export const AVAILABLE_MODES: readonly DispensingMode[] = ['RMP_OWN_PATIENTS'];

export interface PremisesSettings {
  dispensingMode: DispensingMode;
  ndpsLicenceNo: string | null;
  ndpsLicenceValidTill: string | null;
  scheduleXLicenceNo: string | null;
  scheduleXLicenceValidTill: string | null;
  h1RegisterExtraFields: string[];
  prescriptionMaxAgeDays: number | null;
  version: number;
}
const PREMISES_COLS = `dispensing_mode AS "dispensingMode", ndps_licence_no AS "ndpsLicenceNo", ndps_licence_valid_till::text AS "ndpsLicenceValidTill",
  schedule_x_licence_no AS "scheduleXLicenceNo", schedule_x_licence_valid_till::text AS "scheduleXLicenceValidTill",
  h1_register_extra_fields AS "h1RegisterExtraFields", prescription_max_age_days AS "prescriptionMaxAgeDays", version`;
export type PremisesInput = Omit<PremisesSettings, 'version'>;

export interface Location { id: string; name: string; kind: string; storageCondition: string | null; isDefault: boolean; active: boolean }

/** E-04: the caller's premises, each with its settings (null until set up) and locations. */
export async function listDispensaryPremises(s: Session) {
  const ids = s.premises.map((p) => p.id);
  return withTenant(s.orgId, async (db) => {
    const settings = await db.rows<PremisesSettings & { premisesId: string }>(
      `SELECT premises_id AS "premisesId", ${PREMISES_COLS} FROM premises_settings WHERE org_id = $1 AND premises_id = ANY($2::uuid[])`, [s.orgId, ids]);
    const locations = await db.rows<Location & { premisesId: string }>(
      `SELECT id, premises_id AS "premisesId", name, kind, storage_condition AS "storageCondition", is_default AS "isDefault", active
         FROM stock_locations WHERE org_id = $1 AND premises_id = ANY($2::uuid[]) ORDER BY is_default DESC, kind, lower(name)`, [s.orgId, ids]);
    return s.premises.map((p) => {
      const st = settings.find((x) => x.premisesId === p.id);
      return {
        id: p.id, name: p.name,
        settings: st ? (({ premisesId, ...rest }) => { void premisesId; return rest; })(st) : null,
        locations: locations.filter((l) => l.premisesId === p.id).map(({ premisesId, ...l }) => { void premisesId; return l; }),
      };
    });
  });
}

function checkMode(mode: string): void {
  if (!(AVAILABLE_MODES as readonly string[]).includes(mode)) {
    throw new HttpError(422, 'MODE_NOT_AVAILABLE', 'That dispensing mode is not available yet.', { available: AVAILABLE_MODES });
  }
}

const PREMISES_MAP: Record<keyof PremisesInput, string> = {
  dispensingMode: 'dispensing_mode', ndpsLicenceNo: 'ndps_licence_no', ndpsLicenceValidTill: 'ndps_licence_valid_till',
  scheduleXLicenceNo: 'schedule_x_licence_no', scheduleXLicenceValidTill: 'schedule_x_licence_valid_till',
  h1RegisterExtraFields: 'h1_register_extra_fields', prescriptionMaxAgeDays: 'prescription_max_age_days',
};

/** E-05: set a premises up for dispensing: its legal settings, and its store and quarantine locations. */
export async function setupPremises(s: Session, premisesId: string, input: PremisesInput, grantId: string | undefined): Promise<PremisesSettings> {
  requirePremises(s, premisesId);
  checkMode(input.dispensingMode);
  return withSessionTx(s, async (db) => {
    const stock = await db.rows('SELECT 1 FROM stock_settings WHERE org_id = $1', [s.orgId]);
    if (stock.length === 0) throw notConfigured();
    const exists = await db.rows('SELECT 1 FROM premises_settings WHERE org_id = $1 AND premises_id = $2', [s.orgId, premisesId]);
    if (exists.length) throw new HttpError(409, 'PREMISES_ALREADY_CONFIGURED', 'This premises is already set up.');
    await consumeGrant(db, s, 'premises.legal_settings', premisesId, grantId);
    const at = now();
    const keys = Object.keys(PREMISES_MAP) as (keyof PremisesInput)[];
    const r = (await db.rows<PremisesSettings>(
      `INSERT INTO premises_settings (org_id, premises_id, updated_by, updated_at, ${keys.map((k) => PREMISES_MAP[k]).join(', ')})
       VALUES ($1, $2, $3, $4, ${keys.map((_, i) => `$${i + 5}`).join(', ')}) RETURNING ${PREMISES_COLS}`,
      [s.orgId, premisesId, s.staffUserId, at, ...keys.map((k) => input[k])]).catch(checkViolation))[0];
    await db.rows(`INSERT INTO stock_locations (org_id, premises_id, name, kind, is_default, created_at)
                   VALUES ($1, $2, 'Store', 'STORE', true, $3), ($1, $2, 'Quarantine', 'QUARANTINE', false, $3)`, [s.orgId, premisesId, at]);
    await writeAudit(db, { orgId: s.orgId, action: 'premises.legal_settings_changed', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: premisesId,
      detail: { fields: keys.map((k) => PREMISES_MAP[k]), version: r.version } });
    return r;
  });
}

/** E-06: change a premises' legal settings (If-Match, grant). */
export async function putPremisesSettings(s: Session, premisesId: string, input: PremisesInput, ifMatch: string | null, grantId: string | undefined): Promise<PremisesSettings> {
  requirePremises(s, premisesId);
  const version = versionOf(ifMatch);
  checkMode(input.dispensingMode);
  return withSessionTx(s, async (db) => {
    const cur = (await db.rows<PremisesSettings>(`SELECT ${PREMISES_COLS} FROM premises_settings WHERE org_id = $1 AND premises_id = $2 FOR UPDATE`, [s.orgId, premisesId]))[0];
    if (!cur) throw new HttpError(409, 'PREMISES_NOT_CONFIGURED', 'Set this premises up first.');
    if (String(cur.version) !== version) throw new HttpError(412, 'VERSION_CONFLICT', 'Someone else changed these settings. Reload and try again.', { version: cur.version });
    await consumeGrant(db, s, 'premises.legal_settings', premisesId, grantId);
    const keys = (Object.keys(PREMISES_MAP) as (keyof PremisesInput)[]).filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(input[k]));
    if (keys.length === 0) return cur;
    const sets = keys.map((k, i) => `${PREMISES_MAP[k]} = $${i + 3}`).join(', ');
    const r = (await db.rows<PremisesSettings>(
      `UPDATE premises_settings SET ${sets}, version = version + 1, updated_by = $${keys.length + 3}, updated_at = $${keys.length + 4}
        WHERE org_id = $1 AND premises_id = $2 RETURNING ${PREMISES_COLS}`,
      [s.orgId, premisesId, ...keys.map((k) => input[k]), s.staffUserId, now()]).catch(checkViolation))[0];
    await writeAudit(db, { orgId: s.orgId, action: 'premises.legal_settings_changed', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: premisesId,
      detail: { fields: keys.map((k) => PREMISES_MAP[k]), version: r.version } });
    return r;
  });
}

/** E-07: rename a location (or deactivate one that is neither the default nor quarantine). */
export async function patchLocation(s: Session, id: string, input: { name?: string; active?: boolean }): Promise<Location> {
  return withSessionTx(s, async (db) => {
    const cur = (await db.rows<Location & { premisesId: string }>(
      `SELECT id, premises_id AS "premisesId", name, kind, storage_condition AS "storageCondition", is_default AS "isDefault", active
         FROM stock_locations WHERE org_id = $1 AND id = $2 FOR UPDATE`, [s.orgId, id]))[0];
    if (!cur || !s.premises.some((p) => p.id === cur.premisesId)) throw new HttpError(404, 'LOCATION_NOT_FOUND', 'No such location.');
    if (input.active === false && (cur.isDefault || cur.kind === 'QUARANTINE')) {
      throw new HttpError(422, 'LOCATION_REQUIRED', 'The default store and the quarantine location stay active.');
    }
    const name = input.name?.trim() ?? cur.name;
    if (name.toLowerCase() !== cur.name.toLowerCase()) {
      const taken = await db.rows('SELECT 1 FROM stock_locations WHERE org_id = $1 AND premises_id = $2 AND lower(name) = lower($3)', [s.orgId, cur.premisesId, name]);
      if (taken.length) throw new HttpError(409, 'LOCATION_NAME_TAKEN', 'Another location here has that name.');
    }
    return (await db.rows<Location>(
      `UPDATE stock_locations SET name = $3, active = $4 WHERE org_id = $1 AND id = $2
       RETURNING id, name, kind, storage_condition AS "storageCondition", is_default AS "isDefault", active`,
      [s.orgId, id, name, input.active ?? cur.active]).catch(checkViolation))[0];
  });
}
