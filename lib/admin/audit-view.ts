import { HttpError } from '../http/errors';
import { withSessionTx, type Session } from '../auth/guard';

/**
 * M-12 (06a §3.11): the organisation's audit log, newest first, keyset-paginated (06a §12.1).
 * Rows carry ids, codes and a small detail object; no patient content is ever in them.
 */
export interface AuditRow {
  id: string;
  at: string;
  staffUserId: string | null;
  actorLabel: string;
  actorRole: string;
  action: string;
  entityId: string | null;
  deviceId: string | null;
  detail: Record<string, unknown>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function listAudit(s: Session, q: URLSearchParams): Promise<{ items: AuditRow[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(Number(q.get('limit') ?? 50) || 50, 1), 200);
  const from = q.get('from');
  const to = q.get('to');
  const action = q.get('action');
  const staffId = q.get('staffId');
  if ((from && Number.isNaN(Date.parse(from))) || (to && Number.isNaN(Date.parse(to)))) {
    throw new HttpError(422, 'FIELD_INVALID', 'A date is not valid.', { field: from && Number.isNaN(Date.parse(from)) ? 'from' : 'to', rule: 'format' });
  }
  if (action && !/^[a-z_]+(\.[a-z_]+)+$/.test(action)) throw new HttpError(422, 'FIELD_INVALID', 'Not an action.', { field: 'action', rule: 'format' });
  // A foreign or malformed staff id simply matches nothing (06a §12.1, 06b DX-19).
  if (staffId && !UUID.test(staffId)) return { items: [], nextCursor: null };
  let cursor: { at: string; id: string } | null = null;
  const c = q.get('cursor');
  if (c) {
    try {
      cursor = JSON.parse(Buffer.from(c, 'base64url').toString());
      if (!cursor || typeof cursor.at !== 'string' || !UUID.test(cursor.id)) throw new Error();
    } catch {
      throw new HttpError(422, 'FIELD_INVALID', 'Bad cursor.', { field: 'cursor', rule: 'format' });
    }
  }
  const rows = await withSessionTx(s, (db) => db.rows<AuditRow & { at: Date; atText: string }>(
    `SELECT id, at, at::text AS "atText", staff_user_id AS "staffUserId", actor_label AS "actorLabel", actor_role AS "actorRole", action,
            entity_id AS "entityId", device_id AS "deviceId", detail
       FROM audit_log
      WHERE org_id = $1
        AND ($2::timestamptz IS NULL OR at >= $2) AND ($3::timestamptz IS NULL OR at < $3)
        AND ($4::text IS NULL OR action = $4) AND ($5::uuid IS NULL OR staff_user_id = $5)
        AND ($6::timestamptz IS NULL OR (at, id) < ($6, $7::uuid))
      ORDER BY at DESC, id DESC
      LIMIT $8`,
    [s.orgId, from, to, action, staffId, cursor?.at ?? null, cursor?.id ?? null, limit + 1]));
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    items: page.map(({ atText, ...r }) => { void atText; return { ...r, at: r.at.toISOString() }; }),
    // The cursor keeps the database's full precision, so rows in the same millisecond are not skipped.
    nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ at: last.atText, id: last.id })).toString('base64url') : null,
  };
}
