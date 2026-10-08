import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { getItem, patchItem, type ItemPatch } from '@/lib/stock/items';
import { ITEM_PATCH, pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';
type Ctx = { params: { id: string } };

/** E-14: the item, its effective flags and its units (batches and balances come with the ledger, PR 7). */
export const GET = withSession<Ctx>({ permission: 'stock.view' }, async (_req, ctx, s) =>
  json(await getItem(s, pathId(ctx.params.id, 'ITEM_NOT_FOUND', 'No such item.'))));

/** E-15: everything but the item's identity. */
export const PATCH = withSession<Ctx>({ permission: 'stock.items' }, async (req, ctx, s) => {
  const body = await strictBody(req, ITEM_PATCH);
  return json(await patchItem(s, pathId(ctx.params.id, 'ITEM_NOT_FOUND', 'No such item.'), body as ItemPatch));
});
