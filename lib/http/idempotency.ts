import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'crypto';
import type { Db } from '../db/db';
import { now } from '../clock';
import { HttpError } from './errors';

/**
 * Idempotency (06a §12.2, rule 11; 06 R7-2).
 *
 * - Every POST/PUT/PATCH/DELETE needs an `Idempotency-Key` (8–128 of `[A-Za-z0-9_-]`), except
 *   `/api/auth/*` and `/api/account/*` (their own replay rules) and the read-only POSTs.
 * - The key row is inserted FIRST inside the business transaction (the request's first
 *   withSessionTx). A concurrent request with the same key waits on the uncommitted row:
 *   - if the first commits, the second replays: its status and resource id, re-read by the route;
 *   - if the first rolls back, its row goes with it, and the retry runs normally.
 * - The same key with a different request: 422 `IDEMPOTENCY_KEY_REUSED`.
 * - The row keeps the status and the resource id, never a response body (06b DK-09).
 */
export const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
export const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The documented exemptions (06a §12.2). */
export function isExempt(path: string): boolean {
  return /^\/api\/(auth|account)\//.test(path)
    || path === '/api/dispensary/dispenses/preview'
    || /^\/api\/dispensary\/imports\/[^/]+\/validate$/.test(path);
}

interface Pending {
  key: string;
  sha: string;
  method: string;
  path: string;
  /** The status the route answers on success, recorded with the key. */
  status: number;
  /** The key row of this request, once claimed in a transaction that has not yet committed. */
  rowId: string | null;
  /** True once the claiming transaction committed: later transactions of the request leave the key alone. */
  done: boolean;
}

const store = new AsyncLocalStorage<Pending>();

/** Thrown inside the claiming transaction when the key already succeeded: the route replays. */
export class IdempotentReplay extends Error {
  constructor(readonly status: number, readonly resourceId: string | null) {
    super('idempotent replay');
  }
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** The body as sent, and parsed when it is JSON (null otherwise). */
export async function readBody(req: Request): Promise<{ text: string; json: unknown }> {
  const text = await req.clone().text();
  try {
    return { text, json: text ? JSON.parse(text) : null };
  } catch {
    return { text, json: null };
  }
}

/** SHA-256 of method + path + canonical body (JSON with sorted keys; anything else as sent). */
export function requestHash(method: string, path: string, body: { text: string; json: unknown }): string {
  const canon = body.json === null ? body.text : JSON.stringify(canonical(body.json));
  return createHash('sha256').update(`${method}\n${path}\n${canon}`).digest('hex');
}

/** Run a write handler with its key; the first withSessionTx inside claims it. */
export function runIdempotent<T>(p: Omit<Pending, 'rowId' | 'done'>, fn: () => Promise<T>): Promise<T> {
  return store.run({ ...p, rowId: null, done: false }, fn);
}

/** Inside the business transaction, before any other write. */
export async function claimKey(db: Db, orgId: string, staffUserId: string): Promise<void> {
  const p = store.getStore();
  if (!p || p.done) return;
  const ins = await db.rows<{ id: string }>(
    `INSERT INTO idempotency_keys (org_id, key, request_sha256, method, path, staff_user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT ON CONSTRAINT idempotency_keys_key DO NOTHING RETURNING id`,
    [orgId, p.key, p.sha, p.method, p.path, staffUserId, now()]);
  if (ins.length) {
    p.rowId = ins[0].id;
    return;
  }
  const prior = (await db.rows<{ sha: string; status: number | null; resourceId: string | null }>(
    'SELECT request_sha256 AS sha, status, resource_id AS "resourceId" FROM idempotency_keys WHERE org_id = $1 AND key = $2',
    [orgId, p.key]))[0];
  if (!prior || prior.sha !== p.sha) {
    throw new HttpError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request.');
  }
  throw new IdempotentReplay(prior.status ?? p.status, prior.resourceId);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The resource a transaction produced: its result when that is an id, or the result's `id`. */
function resourceIdOf(result: unknown): string | null {
  if (typeof result === 'string' && UUID.test(result)) return result;
  const id = (result as { id?: unknown } | null)?.id;
  return typeof id === 'string' && UUID.test(id) ? id : null;
}

/** At the end of the claiming transaction: record the outcome in it. */
export async function completeKey(db: Db, orgId: string, result: unknown): Promise<void> {
  const p = store.getStore();
  if (!p || p.done || !p.rowId) return;
  await db.rows('UPDATE idempotency_keys SET status = $3, resource_id = $4, completed_at = $5 WHERE org_id = $1 AND id = $2',
    [orgId, p.rowId, p.status, resourceIdOf(result), now()]);
}

/** After the claiming transaction committed. */
export function keyCommitted(): void {
  const p = store.getStore();
  if (p && p.rowId) p.done = true;
}

/** The claiming transaction rolled back: its key row is gone, so a retry claims again. */
export function keyRolledBack(): void {
  const p = store.getStore();
  if (p && !p.done) p.rowId = null;
}
