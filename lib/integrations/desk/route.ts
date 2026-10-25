import { apiError, gated } from '../../http/api';
import { HttpError } from '../../http/errors';
import { resolveOrgBySlug } from '../../db/orgs';
import { now } from '../../clock';
import { log } from '../../log';
import { deskSyncConfig } from './config';
import { verifyDeskSignature } from './signature';

/** What a desk route knows once the request is verified: the env's organisation and premises, and the nonce to consume. */
export interface DeskContext {
  orgId: string;
  premisesId: string;
  nonce: string;
}

export const MAX_BODY_BYTES = 256 * 1024;
const tooLarge = () => new HttpError(413, 'BODY_TOO_LARGE', 'The request body is too large.');

/**
 * Read the raw body with a hard cap: a declared Content-Length over the cap is refused before
 * reading, and the stream is cancelled as soon as it passes the cap, so nothing larger is ever
 * buffered (and nothing is parsed or looked up before the signature is checked).
 */
export async function readCappedBody(req: Request, max = MAX_BODY_BYTES): Promise<string> {
  const declared = req.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > max)) throw tooLarge();
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength))).toString('utf8');
}

/**
 * Route order for /api/integrations/desk/** (06a §12.5):
 * 1. the switch: off → 404 (before anything else, so a deployment without the desk shows no surface);
 * 2. the body, read with a 256 KB cap (413 before anything is buffered past it or parsed);
 * 3. the signature over the raw bytes, then the timestamp window (401): before ANY database work;
 * 4. the self-check gate (503 SCHEMA_UNVERIFIED), as on every other route;
 * 5. the organisation, from DESK_SYNC_ORG_SLUG only (a missing or suspended one is 503 desk_sync_misconfigured);
 * 6. the work, which consumes the nonce in its own transaction (a replay is 401 nonce_reused).
 * No session, no cookie, no Idempotency-Key: each line carries its own idempotency key.
 */
export function deskRoute(handler: (ctx: DeskContext, body: unknown, req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  const inner = gated<{ text: string; nonce: string; premisesId: string; orgSlug: string }>(async (req, v) => {
    const org = await resolveOrgBySlug(v.orgSlug);
    if (!org) {
      log('desk_sync_misconfigured', { check: 'org' });
      throw new HttpError(503, 'desk_sync_misconfigured', 'The desk sync is not set up correctly.');
    }
    let body: unknown = null;
    if (v.text.trim()) {
      try {
        body = JSON.parse(v.text);
      } catch {
        throw new HttpError(400, 'BAD_JSON', 'The request body must be JSON.');
      }
    }
    return handler({ orgId: org.id, premisesId: v.premisesId, nonce: v.nonce }, body, req);
  });
  return async (req) => {
    const cfg = deskSyncConfig();
    if (!cfg) return apiError(404, 'not_found', 'Not found.');
    let text: string;
    let nonce: string;
    try {
      text = await readCappedBody(req);
      nonce = verifyDeskSignature(cfg.key, req, text, now().getTime()).nonce;
    } catch (err) {
      if (err instanceof HttpError) return apiError(err.status, err.code, err.message);
      throw err;
    }
    return inner(req, { text, nonce, premisesId: cfg.premisesId, orgSlug: cfg.orgSlug });
  };
}
