import { json } from '@/lib/http/api';
import { withSession } from '@/lib/http/session-route';
import { getAdjustment } from '@/lib/stock/adjustments';
import { pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';
type Ctx = { params: { id: string } };

/** E-34 GET …/{id}: one adjustment and its lines. */
export const GET = withSession<Ctx>({ permission: 'stock.view' }, async (_req, ctx, s) =>
  json(await getAdjustment(s, pathId(ctx.params.id, 'ADJUSTMENT_NOT_FOUND', 'No such adjustment.'))));
