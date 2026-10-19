import { json } from '@/lib/http/api';
import { HttpError } from '@/lib/http/errors';
import { UUID_PATTERN } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { batchHint } from '@/lib/stock/adjustments';
import { pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';

/** The batch details a stock count can reuse, from the item's newest delivery at `?premisesId=` (D-53). */
export const GET = withSession<{ params: { id: string } }>({ permission: 'stock.view' }, async (req, ctx, s) => {
  const premisesId = new URL(req.url).searchParams.get('premisesId') ?? '';
  if (!UUID_PATTERN.test(premisesId)) throw new HttpError(422, 'FIELD_INVALID', 'premisesId is not valid.', { field: 'premisesId', rule: 'uuid' });
  return json({ hint: await batchHint(s, pathId(ctx.params.id, 'ITEM_NOT_FOUND', 'No such item.'), premisesId.toLowerCase()) });
});
