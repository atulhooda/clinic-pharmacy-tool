import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { getSupplier, listSuppliers, createSupplier } from '@/lib/stock/suppliers';
import { SUPPLIER, optional } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';

/** E-20 GET: the organisation's suppliers with their licence status. */
export const GET = withSession({ permission: 'stock.view' }, async (req, _ctx, s) => json(await listSuppliers(s, new URL(req.url).searchParams)));

/** E-20 POST */
export const POST = withSession({ permission: 'stock.items', idempotent: { status: 201, replay: (s, rid) => getSupplier(s, rid as string) } }, async (req, _ctx, s) => {
  const body = await strictBody(req, { ...optional(SUPPLIER), name: SUPPLIER.name });
  return json(await createSupplier(s, body), { status: 201 });
});
