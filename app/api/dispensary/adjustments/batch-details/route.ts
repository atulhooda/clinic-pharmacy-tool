import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { grantFromRequest } from '@/lib/auth/reauth';
import { HttpError } from '@/lib/http/errors';
import { getAdjustment, parseCountLines, recordBatchDetails } from '@/lib/stock/adjustments';

export const dynamic = 'force-dynamic';

/**
 * E-34 (D-55): record the batch details of stock held as "details pending": moves that quantity onto
 * the real batch. Signed (`stock.adjust` grant for the premises).
 */
export const POST = withSession({ permission: 'stock.adjust', idempotent: { status: 201, replay: (s, rid) => getAdjustment(s, rid as string) } }, async (req, _ctx, s) => {
  const body = await strictBody(req, {
    premisesId: { type: 'uuid' },
    itemId: { type: 'uuid' },
    batchNo: { type: 'string', min: 1, max: 40 },
    expiry: { type: 'string', min: 1, max: 20 },
    mrpPaise: { type: 'int', min: 1, max: 10_000_000_000 },
    mrpUnitId: { type: 'uuid' },
    qtyBase: { type: 'int', min: 1, max: 2_000_000_000, optional: true, nullable: true },
    fromBatchId: { type: 'uuid', optional: true, nullable: true },
  });
  // The batch fields are checked as a count line's new batch is.
  const [line] = parseCountLines([{ itemId: body.itemId, countedBase: 0, newBatch: { batchNo: body.batchNo, expiry: body.expiry, mrpPaise: body.mrpPaise, mrpUnitId: body.mrpUnitId } }]);
  if (!line.newBatch) throw new HttpError(422, 'FIELD_INVALID', 'Batch details are required.');
  const id = await recordBatchDetails(s, { premisesId: body.premisesId.toLowerCase(), itemId: line.itemId, batch: line.newBatch, qtyBase: body.qtyBase ?? null, fromBatchId: body.fromBatchId?.toLowerCase() ?? null }, grantFromRequest(req));
  return json(await getAdjustment(s, id), { status: 201 });
});
