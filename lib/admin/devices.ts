import { now } from '../clock';
import { HttpError } from '../http/errors';
import { writeAudit } from '../audit';
import { withSessionTx, type Session } from '../auth/guard';
import { consumeGrant } from '../auth/reauth';
import { signDeviceToken } from '../auth/device';

/**
 * Trusted PCs (06a §3.5; M-10, M-11). Built in PR 3 because the shared PC needs them
 * (06b DW-01, DW-15).
 */
export interface DeviceView {
  id: string;
  name: string;
  premisesId: string;
  premisesName: string;
  registeredAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  thisDevice: boolean;
}

export async function listDevices(s: Session, cookieDeviceId: string | null): Promise<DeviceView[]> {
  const rows = await withSessionTx(s, (db) => db.rows<Omit<DeviceView, 'thisDevice'> & { registeredAt: Date; lastSeenAt: Date | null; revokedAt: Date | null }>(
    `SELECT d.id, d.name, d.premises_id AS "premisesId", p.name AS "premisesName", d.registered_at AS "registeredAt",
            d.last_seen_at AS "lastSeenAt", d.revoked_at AS "revokedAt"
       FROM devices d JOIN premises p ON p.org_id = d.org_id AND p.id = d.premises_id
      WHERE d.org_id = $1 ORDER BY d.revoked_at IS NOT NULL, lower(d.name)`, [s.orgId]));
  return rows.map((r) => ({
    ...r,
    registeredAt: r.registeredAt.toISOString(),
    lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
    revokedAt: r.revokedAt?.toISOString() ?? null,
    thisDevice: r.id === cookieDeviceId,
  }));
}

/**
 * M-10 POST: trust THIS browser. Needs a `devices.register` grant for the organisation. The
 * owner's current session is bound to the new device and becomes its active one (§3.5).
 */
export async function registerDevice(s: Session, input: { name: string; premisesId: string }, grantId: string | undefined): Promise<{ device: { id: string; name: string }; token: string }> {
  if (s.deviceId) throw new HttpError(409, 'ALREADY_TRUSTED', 'This PC is already trusted.');
  const at = now();
  const id = await withSessionTx(s, async (db) => {
    await consumeGrant(db, s, 'devices.register', s.orgId, grantId);
    const premises = await db.rows('SELECT 1 FROM premises WHERE org_id = $1 AND id = $2 AND active', [s.orgId, input.premisesId]);
    if (premises.length === 0) throw new HttpError(404, 'PREMISES_NOT_FOUND', 'No such premises.');
    const taken = await db.rows('SELECT 1 FROM devices WHERE org_id = $1 AND lower(name) = lower($2) AND revoked_at IS NULL', [s.orgId, input.name.trim()]);
    if (taken.length) throw new HttpError(409, 'DEVICE_NAME_TAKEN', 'Another trusted PC already has that name.');
    const d = (await db.rows<{ id: string }>(
      `INSERT INTO devices (org_id, premises_id, name, registered_by, registered_at, last_seen_at)
       VALUES ($1, $2, $3, $4, $5, $5) RETURNING id`, [s.orgId, input.premisesId, input.name.trim(), s.staffUserId, at]))[0];
    await db.rows('UPDATE sessions SET device_id = $3, last_input_at = $4 WHERE org_id = $1 AND id = $2', [s.orgId, s.sid, d.id, at]);
    await db.rows('INSERT INTO device_state (org_id, device_id, active_session_id, updated_at) VALUES ($1, $2, $3, $4)', [s.orgId, d.id, s.sid, at]);
    await writeAudit(db, { orgId: s.orgId, action: 'auth.device_registered', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: d.id, entityId: d.id, detail: { device_id: d.id } });
    return d.id;
  });
  return { device: { id, name: input.name.trim() }, token: await signDeviceToken(s.orgId, id) };
}

/** M-11: revoke a PC. Every session on it ends at its next request (06b DW-15). */
export async function revokeDevice(s: Session, deviceId: string): Promise<{ endedSessions: number }> {
  const at = now();
  return withSessionTx(s, async (db) => {
    const d = (await db.rows<{ revokedAt: Date | null }>(
      'SELECT revoked_at AS "revokedAt" FROM devices WHERE org_id = $1 AND id = $2 FOR UPDATE', [s.orgId, deviceId]))[0];
    if (!d) throw new HttpError(404, 'DEVICE_NOT_FOUND', 'No such device.');
    if (d.revokedAt) return { endedSessions: 0 };
    await db.rows('UPDATE devices SET revoked_at = $3, revoked_by = $4 WHERE org_id = $1 AND id = $2', [s.orgId, deviceId, at, s.staffUserId]);
    await db.rows('UPDATE device_state SET active_session_id = NULL, updated_at = $3 WHERE org_id = $1 AND device_id = $2', [s.orgId, deviceId, at]);
    const ended = await db.rows(`UPDATE sessions SET revoked_at = $3, revoked_reason = 'device_revoked'
                                  WHERE org_id = $1 AND device_id = $2 AND revoked_at IS NULL RETURNING id`, [s.orgId, deviceId, at]);
    await writeAudit(db, { orgId: s.orgId, action: 'auth.device_revoked', actorLabel: s.name, actorRole: s.roleKey,
      staffUserId: s.staffUserId, sessionId: s.sid, deviceId: s.deviceId, entityId: deviceId,
      detail: { device_id: deviceId, count: ended.length } });
    return { endedSessions: ended.length };
  });
}
