import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { getItem, patchUnit } from '@/lib/stock/items';
import { pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';

/** E-17: a unit's flags only; the factor is immutable. */
export const PATCH = withSession<{ params: { id: string; unitId: string } }>({ permission: 'stock.items', idempotent: { status: 200,
  replay: async (s, _rid, ctx) => (await getItem(s, ctx.params.id.toLowerCase())).units.find((u) => u.id === ctx.params.unitId.toLowerCase()) } }, async (req, ctx, s) => {
  const body = await strictBody(req, {
    dispensable: { type: 'bool', optional: true },
    purchasable: { type: 'bool', optional: true },
    active: { type: 'bool', optional: true },
  });
  return json(await patchUnit(s, pathId(ctx.params.id, 'ITEM_NOT_FOUND', 'No such item.'), pathId(ctx.params.unitId, 'UNIT_NOT_FOUND', 'No such unit.'), body));
});
