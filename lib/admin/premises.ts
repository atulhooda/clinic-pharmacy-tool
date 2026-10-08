import { now } from '../clock';
import { HttpError } from '../http/errors';
import { writeAudit } from '../audit';
import { withSessionTx, type Session } from '../auth/guard';
import { consumeGrant } from '../auth/reauth';

/**
 * Premises (06a §2.1, §6.1; M-02 … M-04). Creating or editing one needs an `org.settings`
 * grant (§3.7). The legal settings (mode, licences, register fields) are E-05/E-06 (PR 5).
 */
export interface PremisesView {
  id: string;
  name: string;
  address: string;
  stateCode: string;
  gstin: string | null;
  legalName: string | null;
  active: boolean;
}
const COLS = `id, name, address, state_code AS "stateCode", gstin, legal_name AS "legalName", active`;
const notFound = () => new HttpError(404, 'PREMISES_NOT_FOUND', 'No such premises.');

/** M-02: the caller's premises (the owner: all of them, inactive ones included). */
export async function listPremises(s: Session): Promise<PremisesView[]> {
  return withSessionTx(s, (db) => s.isOwner
    ? db.rows<PremisesView>(`SELECT ${COLS} FROM premises WHERE org_id = $1 ORDER BY lower(name)`, [s.orgId])
    : db.rows<PremisesView>(`SELECT ${COLS} FROM premises WHERE org_id = $1 AND id = ANY($2::uuid[]) ORDER BY lower(name)`,
      [s.orgId, s.premises.map((p) => p.id)]));
}

export interface PremisesInput {
  name?: string;
  address?: string;
  stateCode?: string;
  gstin?: string | null;
  legalName?: string | null;
  active?: boolean;
}

/** GSTIN format, and its first two digits are the premises' state code (06a §6.1). */
function checkGstin(gstin: string | null | undefined, stateCode: string): void {
  if (!gstin) return;
  if (!/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/.test(gstin)) throw new HttpError(422, 'GSTIN_INVALID', 'That GSTIN is not in the right format.');
  if (gstin.slice(0, 2) !== stateCode) throw new HttpError(422, 'GSTIN_STATE_MISMATCH', "The GSTIN's first two digits must be the state code.");
}

async function nameTaken(db: Parameters<Parameters<typeof withSessionTx>[1]>[0], orgId: string, name: string, exceptId: string | null) {
  const r = await db.rows('SELECT 1 FROM premises WHERE org_id = $1 AND lower(name) = lower($2) AND ($3::uuid IS NULL OR id <> $3)', [orgId, name.trim(), exceptId]);
  if (r.length) throw new HttpError(409, 'PREMISES_NAME_TAKEN', 'Another premises already has that name.');
}

export async function createPremises(s: Session, input: Required<Pick<PremisesInput, 'name' | 'address' | 'stateCode'>> & PremisesInput, grantId: string | undefined): Promise<PremisesView> {
  const gstin = input.gstin ? input.gstin.toUpperCase() : null;
  checkGstin(gstin, input.stateCode);
  return withSessionTx(s, async (db) => {
    await consumeGrant(db, s, 'org.settings', s.orgId, grantId);
    await nameTaken(db, s.orgId, input.name, null);
    const p = (await db.rows<PremisesView>(
      `INSERT INTO premises (org_id, name, address, state_code, gstin, legal_name, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLS}`,
      [s.orgId, input.name.trim(), input.address.trim(), input.stateCode, gstin, input.legalName?.trim() || null, now()]))[0];
    await writeAudit(db, { orgId: s.orgId, action: 'premises.created', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: p.id });
    return p;
  });
}

export async function patchPremises(s: Session, id: string, input: PremisesInput, grantId: string | undefined): Promise<PremisesView> {
  return withSessionTx(s, async (db) => {
    const cur = (await db.rows<PremisesView>(`SELECT ${COLS} FROM premises WHERE org_id = $1 AND id = $2 FOR UPDATE`, [s.orgId, id]))[0];
    if (!cur) throw notFound();
    await consumeGrant(db, s, 'org.settings', s.orgId, grantId);
    const next = {
      name: input.name?.trim() ?? cur.name,
      address: input.address?.trim() ?? cur.address,
      stateCode: input.stateCode ?? cur.stateCode,
      gstin: input.gstin === undefined ? cur.gstin : input.gstin ? input.gstin.toUpperCase() : null,
      legalName: input.legalName === undefined ? cur.legalName : input.legalName?.trim() || null,
      active: input.active ?? cur.active,
    };
    checkGstin(next.gstin, next.stateCode);
    if (next.name.toLowerCase() !== cur.name.toLowerCase()) await nameTaken(db, s.orgId, next.name, id);
    const fields = (Object.keys(next) as (keyof typeof next)[]).filter((k) => next[k] !== cur[k]);
    if (fields.length === 0) return cur;
    const p = (await db.rows<PremisesView>(
      `UPDATE premises SET name = $3, address = $4, state_code = $5, gstin = $6, legal_name = $7, active = $8
        WHERE org_id = $1 AND id = $2 RETURNING ${COLS}`,
      [s.orgId, id, next.name, next.address, next.stateCode, next.gstin, next.legalName, next.active]))[0];
    await writeAudit(db, { orgId: s.orgId, action: 'premises.changed', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: id,
      detail: { fields: fields.map((f) => f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)) } });
    return p;
  });
}
