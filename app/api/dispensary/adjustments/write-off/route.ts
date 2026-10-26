import { json } from '@/lib/http/api';
import { strictBody, UUID_PATTERN } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { HttpError } from '@/lib/http/errors';
import { getAdjustment, writeOff, type WriteOffKind } from '@/lib/stock/adjustments';

export const dynamic = 'force-dynamic';

/** E-34 write-off kinds (D-58): expired or damaged stock leaves for good. Signed (`stock.writeoff` grant for the premises). */
export const POST = withSession({ permission: 'stock.writeoff', idempotent: { status: 201, replay: (s, rid) => getAdjustment(s, rid as string) } }, async (req, _ctx, s) => {
  const body = await strictBody(req, {
    premisesId: { type: 'uuid' },
    kind: { type: 'string', pattern: /^(EXPIRY_WRITEOFF|DAMAGE_WRITEOFF)$/ },
    reasonCode: { type: 'string', max: 40 },
    note: { type: 'string', min: 1, max: 500, optional: true, nullable: true },
    lines: { type: 'objects', max: 100 },
  });
  const lines = body.lines.map((l, i) => {
    for (const k of Object.keys(l)) if (!['itemId', 'batchId', 'qtyBase'].includes(k)) throw new HttpError(422, 'UNKNOWN_FIELD', `Unknown field lines[${i}].${k}.`);
    const ok = (v: unknown) => typeof v === 'string' && UUID_PATTERN.test(v);
    if (!ok(l.itemId) || (l.batchId != null && !ok(l.batchId))) throw new HttpError(422, 'FIELD_INVALID', `lines[${i}] is not valid.`, { field: `lines[${i}]`, rule: 'uuid' });
    const q = l.qtyBase;
    if (q != null && (typeof q !== 'number' || !Number.isSafeInteger(q) || q < 1)) throw new HttpError(422, 'FIELD_INVALID', `lines[${i}].qtyBase is not valid.`, { field: `lines[${i}].qtyBase`, rule: 'int' });
    return { itemId: (l.itemId as string).toLowerCase(), batchId: l.batchId ? (l.batchId as string).toLowerCase() : null, qtyBase: (q as number | null | undefined) ?? null };
  });
  const id = await writeOff(s, { premisesId: body.premisesId.toLowerCase(), kind: body.kind as WriteOffKind, reasonCode: body.reasonCode, note: body.note?.trim() || null, lines }, grantFromRequest(req));
  return json(await getAdjustment(s, id), { status: 201 });
});
