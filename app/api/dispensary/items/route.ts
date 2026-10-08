import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { listItems, createItem, type ItemCreate } from '@/lib/stock/items';
import { ITEM_CREATE } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';

/** E-12: the catalogue, `?q=&category=&limit=&cursor=`. */
export const GET = withSession({ permission: 'stock.view' }, async (req, _ctx, s) => json(await listItems(s, new URL(req.url).searchParams)));

/** E-13: create an item from the master or as a custom item. */
export const POST = withSession({ permission: 'stock.items' }, async (req, _ctx, s) => {
  const body = await strictBody(req, ITEM_CREATE);
  return json(await createItem(s, body as ItemCreate), { status: 201 });
});
