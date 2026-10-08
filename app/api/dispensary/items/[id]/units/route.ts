import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { getItem, addUnit } from '@/lib/stock/items';
import { pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';

/** E-16: add a pack unit; its factor to the base unit never changes. */
export const POST = withSession<{ params: { id: string } }>({ permission: 'stock.items', idempotent: { status: 201,
  replay: async (s, rid, ctx) => (await getItem(s, ctx.params.id.toLowerCase())).units.find((u) => u.id === rid) } }, async (req, ctx, s) => {
  const body = await strictBody(req, {
    name: { type: 'string', min: 1, max: 40 },
    baseUnitsPerUnit: { type: 'int', min: 2, max: 100_000 },
    dispensable: { type: 'bool', optional: true },
    purchasable: { type: 'bool', optional: true },
  });
  return json(await addUnit(s, pathId(ctx.params.id, 'ITEM_NOT_FOUND', 'No such item.'), body), { status: 201 });
});
