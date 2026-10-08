import { json } from '@/lib/http/api';
import { strictBody } from '@/lib/http/body';
import { withSession } from '@/lib/http/session-route';
import { patchLocation } from '@/lib/stock/settings';
import { pathId } from '@/lib/stock/schemas';

export const dynamic = 'force-dynamic';

/** E-07: rename a location. */
export const PATCH = withSession<{ params: { id: string } }>({ permission: 'stock.settings' }, async (req, ctx, s) => {
  const body = await strictBody(req, { name: { type: 'string', min: 1, max: 64, optional: true }, active: { type: 'bool', optional: true } });
  return json(await patchLocation(s, pathId(ctx.params.id, 'LOCATION_NOT_FOUND', 'No such location.'), body));
});
