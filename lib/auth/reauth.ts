import type { Db } from '../db/db';
import { withTenant } from '../db/tenant';
import { now } from '../clock';
import { HttpError, AuthError } from '../http/errors';
import { verifyPassword } from './password';
import { hashPin, verifyPin } from './pins';
import { holdsPinGatedPermission } from './permissions';
import { withSessionTx, type Session } from './guard';
import { takeSecretTry, giveBackTry, wrongSecret } from './account';

/**
 * Signing-PIN re-authentication (06a §3.7). A-12 turns the signing PIN (or the account
 * password, never the switch PIN) into a grant that is single use, valid for 2 minutes and
 * bound to (session, user, purpose, entity). The operation consumes it inside its own
 * transaction, so a failed operation leaves it unused.
 */
export const PURPOSES = [
  'prescription.verify', 'container.lapse_override', 'stock.reverse', 'stock.backdate', 'stock.writeoff',
  'stock.adjust', 'stock.import_commit', 'premises.legal_settings', 'register.export', 'staff.manage',
  'roles.manage', 'devices.register', 'org.settings', 'patients.merge',
] as const;
export type Purpose = (typeof PURPOSES)[number];

const GRANT_MS = 2 * 60 * 1000;
export const REAUTH_HEADER = 'reauth-grant';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function issueGrant(
  s: Session,
  input: { pin?: string; password?: string; purpose: string; entityId: string },
): Promise<{ grantId: string; expiresAt: Date }> {
  if (!(PURPOSES as readonly string[]).includes(input.purpose)) {
    throw new HttpError(422, 'FIELD_INVALID', 'Unknown purpose.', { field: 'purpose', rule: 'enum' });
  }
  if (input.pin === undefined && input.password === undefined) {
    throw new HttpError(422, 'CREDENTIAL_REQUIRED', 'Enter your signing PIN or your password.');
  }
  if (input.pin !== undefined && input.password !== undefined) {
    throw new HttpError(422, 'FIELD_INVALID', 'Send the signing PIN or the password, not both.', { field: 'password', rule: 'exclusive' });
  }
  // §3.7, D-63: confirmations are made with the login password (founder, 2026-10-28); a PIN is only checked if one is sent.
  if (!s.hasSigningPin && input.pin !== undefined) {
    throw new HttpError(409, 'signing_pin_not_set', 'Set your signing PIN first.');
  }
  const tries = await takeSecretTry(s);
  const stored = await withTenant(s.orgId, async (db) => (await db.rows<{ password: string | null; signingPin: string | null }>(
    'SELECT password_hash AS password, signing_pin_hash AS "signingPin" FROM staff_users WHERE org_id = $1 AND id = $2',
    [s.orgId, s.staffUserId]))[0]);
  let rehash: string | null = null;
  if (input.pin !== undefined) {
    const r = await verifyPin(input.pin, stored.signingPin);
    if (!r.ok) await wrongSecret(s, tries, 'signing_pin');
    if (r.stale) rehash = await hashPin(input.pin);
  } else if (!(stored.password && (await verifyPassword(input.password!, stored.password)))) {
    await wrongSecret(s, tries, 'password');
  }
  const at = now();
  return withSessionTx(s, async (db) => {
    await giveBackTry(db, s);
    // §3.12 step 2: a hash on an older pepper moves to the current one on a successful check.
    if (rehash) {
      await db.rows('UPDATE staff_users SET signing_pin_hash = $3 WHERE org_id = $1 AND id = $2 AND signing_pin_hash = $4',
        [s.orgId, s.staffUserId, rehash, stored.signingPin]);
    }
    const g = (await db.rows<{ id: string; expiresAt: Date }>(
      `INSERT INTO reauth_grants (org_id, session_id, staff_user_id, purpose, entity_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, expires_at AS "expiresAt"`,
      [s.orgId, s.sid, s.staffUserId, input.purpose, input.entityId, at, new Date(at.getTime() + GRANT_MS)]))[0];
    return { grantId: g.id, expiresAt: g.expiresAt };
  });
}

/** The grant id a request carries in the Reauth-Grant header (§3.7), if any. */
export function grantFromRequest(req: Request): string | undefined {
  const v = req.headers.get(REAUTH_HEADER)?.trim();
  return v && UUID.test(v) ? v : undefined;
}

/**
 * Consume a grant inside the operation's own transaction. No matching unused, unexpired grant
 * for this session, user, purpose and entity → 401 reauth_required.
 */
export async function consumeGrant(db: Db, s: Pick<Session, 'orgId' | 'sid' | 'staffUserId'>, purpose: Purpose, entityId: string, grantId: string | undefined): Promise<void> {
  const at = now();
  const used = grantId ? await db.rows(
    `UPDATE reauth_grants SET used_at = $7
      WHERE org_id = $1 AND id = $2 AND session_id = $3 AND staff_user_id = $4 AND purpose = $5 AND entity_id = $6
        AND used_at IS NULL AND expires_at > $7
     RETURNING id`, [s.orgId, grantId, s.sid, s.staffUserId, purpose, entityId, at]) : [];
  if (used.length === 0) throw new AuthError(401, 'reauth_required', 'Confirm with your signing PIN.', { purpose });
}
