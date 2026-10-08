import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { getSupplier, patchSupplier } from '@/lib/stock/suppliers';
import { SUPPLIER, optional, pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';
type Ctx = { params: { id: string } };

/** E-21 GET */
export const GET = withSession<Ctx>({ permission: 'stock.view' }, async (_req, ctx, s) =>
  json(await getSupplier(s, pathId(ctx.params.id, 'SUPPLIER_NOT_FOUND', 'No such supplier.'))));

/** E-21 PATCH */
export const PATCH = withSession<Ctx>({ permission: 'stock.items', idempotent: { status: 200,
  replay: (s, _rid, ctx) => getSupplier(s, pathId(ctx.params.id, 'SUPPLIER_NOT_FOUND', 'No such supplier.')) } }, async (req, ctx, s) => {
  const body = await strictBody(req, optional(SUPPLIER));
  return json(await patchSupplier(s, pathId(ctx.params.id, 'SUPPLIER_NOT_FOUND', 'No such supplier.'), body));
});
