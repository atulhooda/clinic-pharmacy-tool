import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { createGrn, getGrn, listGrns } from '@/lib/stock/receipts';

export const dynamic = 'force-dynamic';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** E-23 GET: deliveries at the caller's premises; `?status=&premisesId=&supplierId=`. */
export const GET = withSession({ permission: 'stock.view' }, async (req, _ctx, s) => json(await listGrns(s, new URL(req.url).searchParams)));

/** E-23 POST: a new draft delivery (received at posting, Milestone 1). */
export const POST = withSession({ permission: 'stock.receive', idempotent: { status: 201, replay: (s, rid) => getGrn(s, rid as string) } }, async (req, _ctx, s) => {
  const body = await strictBody(req, {
    premisesId: { type: 'uuid' },
    supplierId: { type: 'uuid' },
    locationId: { type: 'uuid', optional: true, nullable: true },
    invoiceNo: { type: 'string', min: 1, max: 40 },
    invoiceDate: { type: 'string', pattern: DATE },
    invoiceTotalPaise: { type: 'int', min: 0, max: 10_000_000_000, optional: true, nullable: true },
    notes: { type: 'string', max: 500, optional: true, nullable: true },
    lines: { type: 'objects', max: 200, optional: true },
  });
  const { premisesId, ...rest } = body;
  return json(await getGrn(s, await createGrn(s, premisesId, rest)), { status: 201 });
});
