import { now } from '../clock';
import { HttpError } from '../http/errors';
import { writeAudit } from '../audit';
import { withSessionTx, type Session } from '../auth/guard';
import { consumeGrant } from '../auth/reauth';

/**
 * M-01 (06a §6.1, §3.4, §3.6): the organisation's security settings. Writes need an
 * `org.settings` grant and `If-Match: <version>`; every change is snapshotted by the history
 * trigger and audited in the same transaction.
 */
export interface OrgSettings {
  deviceLockMinutes: number;
  dayResetTimeIst: string;
  untrustedIdleMinutes: number | null;
  version: number;
  updatedAt: string;
}

interface Row { deviceLockMinutes: number; dayResetTimeIst: string; untrustedIdleMinutes: number | null; version: number; updatedAt: Date }
const SELECT = `SELECT device_lock_minutes AS "deviceLockMinutes", to_char(day_reset_time_ist, 'HH24:MI') AS "dayResetTimeIst",
                       untrusted_idle_minutes AS "untrustedIdleMinutes", version, updated_at AS "updatedAt"
                  FROM org_settings WHERE org_id = $1`;
const view = (r: Row): OrgSettings => ({ ...r, updatedAt: r.updatedAt.toISOString() });

export async function getOrgSettings(s: Session): Promise<OrgSettings> {
  const r = await withSessionTx(s, async (db) => (await db.rows<Row>(SELECT, [s.orgId]))[0]);
  if (!r) throw new HttpError(409, 'ORG_NOT_CONFIGURED', 'This organisation has no settings row.');
  return view(r);
}

export async function putOrgSettings(
  s: Session,
  input: { deviceLockMinutes: number; dayResetTimeIst: string; untrustedIdleMinutes: number | null },
  ifMatch: string | null,
  grantId: string | undefined,
): Promise<OrgSettings> {
  if (!ifMatch) throw new HttpError(428, 'IF_MATCH_REQUIRED', 'Send the version you edited in If-Match.');
  return withSessionTx(s, async (db) => {
    await consumeGrant(db, s, 'org.settings', s.orgId, grantId);
    const cur = (await db.rows<Row>(`${SELECT} FOR UPDATE`, [s.orgId]))[0];
    if (!cur) throw new HttpError(409, 'ORG_NOT_CONFIGURED', 'This organisation has no settings row.');
    if (String(cur.version) !== ifMatch.replace(/^W\//, '').replace(/"/g, '')) {
      throw new HttpError(412, 'VERSION_CONFLICT', 'Someone else changed these settings. Reload and try again.', { version: cur.version });
    }
    const fields = (['deviceLockMinutes', 'dayResetTimeIst', 'untrustedIdleMinutes'] as const).filter((k) => cur[k] !== input[k]);
    if (fields.length === 0) return view(cur);
    const r = (await db.rows<Row>(
      `UPDATE org_settings SET device_lock_minutes = $2, day_reset_time_ist = $3::time, untrusted_idle_minutes = $4,
              version = version + 1, updated_by = $5, updated_at = $6
        WHERE org_id = $1
       RETURNING device_lock_minutes AS "deviceLockMinutes", to_char(day_reset_time_ist, 'HH24:MI') AS "dayResetTimeIst",
                 untrusted_idle_minutes AS "untrustedIdleMinutes", version, updated_at AS "updatedAt"`,
      [s.orgId, input.deviceLockMinutes, input.dayResetTimeIst, input.untrustedIdleMinutes, s.staffUserId, now()]))[0];
    await writeAudit(db, { orgId: s.orgId, action: 'org.settings_changed', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: s.orgId,
      detail: { fields: fields.map((f) => f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)), version: r.version } });
    return view(r);
  });
}
