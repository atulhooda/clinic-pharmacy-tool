import type { Db } from './db/db';
import { withTenant } from './db/tenant';
import { now } from './clock';
import { log } from './log';

/**
 * The audit log (06a §3.11). No patient content: detail keys come from an allow-list, and
 * values are booleans, null, integers within ±1e9 (so a phone number cannot pass), UUIDs,
 * UTC timestamps, lower-case tokens, or arrays of tokens. Field names, never values.
 */
export const AUDIT_DETAIL_KEYS: ReadonlySet<string> = new Set([
  'method', 'reason', 'kind', 'fields', 'role', 'from', 'to', 'count', 'channel', 'purpose',
  'device_id', 'from_session_id', 'to_session_id', 'version', 'permission', 'register', 'format',
  'from_date', 'to_date', 'paused', 'remaining',
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UTC_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;
const TOKEN = /^[a-z0-9_.:-]{1,64}$/;

export class AuditDetailError extends Error {}

function okValue(v: unknown): boolean {
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isInteger(v) && Math.abs(v) <= 1e9;
  if (typeof v === 'string') return UUID.test(v) || UTC_TS.test(v) || TOKEN.test(v);
  if (Array.isArray(v)) return v.length <= 50 && v.every((x) => typeof x === 'string' && TOKEN.test(x));
  return false;
}

export function sanitizeDetail(detail: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(detail)) {
    if (!AUDIT_DETAIL_KEYS.has(k)) throw new AuditDetailError(`audit detail key "${k}" is not on the allow-list`);
    if (!okValue(v)) throw new AuditDetailError(`audit detail "${k}" has a value that is not allowed`);
  }
  if (JSON.stringify(detail).length > 2048) throw new AuditDetailError('audit detail is over 2 KB');
  return detail;
}

export interface AuditEvent {
  orgId: string;
  action: string;
  actorLabel: string;
  actorRole: string;
  staffUserId?: string | null;
  sessionId?: string | null;
  deviceId?: string | null;
  entityId?: string | null;
  detail?: Record<string, unknown>;
}

/** Transactional: written in the caller's transaction, so the change and its audit row land together. */
export async function writeAudit(db: Db, e: AuditEvent): Promise<void> {
  const detail = sanitizeDetail(e.detail);
  await db.rows(
    `INSERT INTO audit_log (org_id, at, staff_user_id, session_id, device_id, actor_label, actor_role, action, entity_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [e.orgId, now(), e.staffUserId ?? null, e.sessionId ?? null, e.deviceId ?? null, e.actorLabel.slice(0, 64),
      e.actorRole, e.action, e.entityId ?? null, JSON.stringify(detail)],
  );
}

/**
 * Best-effort, after the main work: a failed audit write must never turn a completed action
 * into an error. Only the action name and error code are logged.
 */
export async function auditBestEffort(e: AuditEvent): Promise<void> {
  try {
    await withTenant(e.orgId, (db) => writeAudit(db, e));
  } catch (err) {
    log('audit_failed', { action: e.action, code: (err as { code?: string }).code ?? (err as Error).name });
  }
}
