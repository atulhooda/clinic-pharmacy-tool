import { json } from '@/lib/http/api';
import { withSession } from '@/lib/http/session-route';
import { itemMovements } from '@/lib/stock/ledger';
import { pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';

/** E-18: the item's ledger history at the caller's premises, newest first; `?premisesId=&limit=&cursor=`. No patient fields. */
export const GET = withSession<{ params: { id: string } }>({ permission: 'stock.view' }, async (req, ctx, s) =>
  json(await itemMovements(s, pathId(ctx.params.id, 'ITEM_NOT_FOUND', 'No such item.'), new URL(req.url).searchParams)));
