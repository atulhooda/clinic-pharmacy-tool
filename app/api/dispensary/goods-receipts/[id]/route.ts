import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { getGrn, patchGrn } from '@/lib/stock/receipts';
import { pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';
type Ctx = { params: { id: string } };
const id = (ctx: Ctx) => pathId(ctx.params.id, 'GRN_NOT_FOUND', 'No such delivery.');

/** E-24 GET: a delivery with its lines; a draft also carries what posting would say now. */
export const GET = withSession<Ctx>({ permission: 'stock.view' }, async (_req, ctx, s) => json(await getGrn(s, id(ctx))));

/** E-24 PATCH: edit a draft's header, or replace its lines (409 GRN_NOT_DRAFT once posted). */
export const PATCH = withSession<Ctx>({ permission: 'stock.receive', idempotent: { status: 200, replay: (s, _rid, ctx) => getGrn(s, id(ctx)) } }, async (req, ctx, s) => {
  const body = await strictBody(req, {
    supplierId: { type: 'uuid', optional: true },
    locationId: { type: 'uuid', optional: true },
    invoiceNo: { type: 'string', min: 1, max: 40, optional: true },
    invoiceDate: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/, optional: true },
    invoiceTotalPaise: { type: 'int', min: 0, max: 10_000_000_000, optional: true, nullable: true },
    notes: { type: 'string', max: 500, optional: true, nullable: true },
    lines: { type: 'objects', max: 200, optional: true },
  });
  return json(await getGrn(s, await patchGrn(s, id(ctx), body)));
});
